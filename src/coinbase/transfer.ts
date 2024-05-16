import { TransferAPIClient, TransferStatus } from "./types";
import { Coinbase } from "./coinbase";
import { Transfer as TransferModel } from "../client/api";
import { ethers } from "ethers";
import { InternalError, InvalidUnsignedPayload } from "./errors";
import { delay } from "./utils";

/**
 * The Transfer API client types.
 */
export type TransferClients = {
  transfer: TransferAPIClient;
  baseSepoliaProvider: ethers.Provider;
};

/**
 * A representation of a Transfer, which moves an Amount of an Asset from
 * a user-controlled Wallet to another Address. The fee is assumed to be paid
 * in the native Asset of the Network.
 */
export class Transfer {
  private model: TransferModel;
  private client: TransferClients;
  private transaction?: ethers.Transaction;

  /**
   * Initializes a new Transfer instance.
   *
   * @param transferModel - The Transfer model.
   * @param client - The API clients.
   */
  constructor(transferModel: TransferModel, client: TransferClients) {
    if (!transferModel) {
      throw new InternalError("Transfer model cannot be empty");
    }
    this.model = transferModel;

    if (!client) {
      throw new InternalError("API clients cannot be empty");
    }
    this.client = client;
  }

  /**
   * Returns the ID of the Transfer.
   *
   * @returns The Transfer ID.
   */
  public getId(): string {
    return this.model.transfer_id;
  }

  /**
   * Returns the Network ID of the Transfer.
   *
   * @returns The Network ID.
   */
  public getNetworkId(): string {
    return this.model.network_id;
  }

  /**
   * Returns the Wallet ID of the Transfer.
   *
   * @returns The Wallet ID.
   */
  public getWalletId(): string {
    return this.model.wallet_id;
  }

  /**
   * Returns the From Address ID of the Transfer.
   *
   * @returns The From Address ID.
   */
  public getFromAddressId(): string {
    return this.model.address_id;
  }

  /**
   * Returns the Destination Address ID of the Transfer.
   *
   * @returns The Destination Address ID.
   */
  public getDestinationAddressId(): string {
    return this.model.destination;
  }

  /**
   * Returns the Asset ID of the Transfer.
   *
   * @returns The Asset ID.
   */
  public getAssetId(): string {
    return this.model.asset_id;
  }

  /**
   * Returns the Amount of the Transfer.
   *
   * @returns The Amount of the Asset.
   */
  public getAmount(): bigint {
    const amount = BigInt(this.model.amount);

    if (this.getAssetId() === Coinbase.assetList.Eth) {
      return amount / BigInt(Coinbase.WEI_PER_ETHER);
    }
    return BigInt(this.model.amount);
  }

  /**
   * Returns the Unsigned Payload of the Transfer.
   *
   * @returns The Unsigned Payload as a Hex string.
   */
  public getUnsignedPayload(): string {
    return this.model.unsigned_payload;
  }

  /**
   * Returns the Signed Payload of the Transfer.
   *
   * @returns The Signed Payload as a Hex string, or undefined if not yet available.
   */
  public getSignedPayload(): string | undefined {
    return this.model.signed_payload;
  }

  /**
   * Returns the Transaction Hash of the Transfer.
   *
   * @returns The Transaction Hash as a Hex string, or undefined if not yet available.
   */
  public getTransactionHash(): string | undefined {
    return this.model.transaction_hash;
  }

  /**
   * Returns the Transaction of the Transfer.
   *
   * @returns The ethers.js Transaction object.
   * @throws (InvalidUnsignedPayload) If the Unsigned Payload is invalid.
   */
  public getTransaction(): ethers.Transaction {
    if (this.transaction) return this.transaction;

    const transaction = new ethers.Transaction();

    const rawPayload = this.getUnsignedPayload()
      .match(/../g)
      ?.map(byte => parseInt(byte, 16));
    if (!rawPayload) {
      throw new InvalidUnsignedPayload("Unable to parse unsigned payload");
    }

    let parsedPayload;
    try {
      const rawPayloadBytes = new Uint8Array(rawPayload);
      const decoder = new TextDecoder();
      parsedPayload = JSON.parse(decoder.decode(rawPayloadBytes));
    } catch (error) {
      throw new InvalidUnsignedPayload("Unable to decode unsigned payload JSON");
    }

    transaction.chainId = BigInt(parsedPayload.chainId);
    transaction.nonce = BigInt(parsedPayload.nonce);
    transaction.maxPriorityFeePerGas = BigInt(parsedPayload.maxPriorityFeePerGas);
    transaction.maxFeePerGas = BigInt(parsedPayload.maxFeePerGas);
    transaction.gasLimit = BigInt(parsedPayload.gas);
    transaction.to = parsedPayload.to;
    transaction.value = BigInt(parsedPayload.value);
    transaction.data = parsedPayload.input;

    this.transaction = transaction;
    return transaction;
  }

  /**
   * Sets the Signed Transaction of the Transfer.
   *
   * @param transaction - The Signed Transaction.
   */
  public setSignedTransaction(transaction: ethers.Transaction): void {
    this.transaction = transaction;
  }

  /**
   * Returns the Status of the Transfer.
   *
   * @returns The Status of the Transfer.
   */
  public async getStatus(): Promise<TransferStatus> {
    const transactionHash = this.getTransactionHash();
    if (!transactionHash) return TransferStatus.PENDING;

    const onchainTransaction =
      await this.client.baseSepoliaProvider!.getTransaction(transactionHash);
    if (!onchainTransaction) return TransferStatus.PENDING;
    if (!onchainTransaction.blockHash) return TransferStatus.BROADCAST;

    const transactionReceipt =
      await this.client.baseSepoliaProvider!.getTransactionReceipt(transactionHash);
    return transactionReceipt?.status ? TransferStatus.COMPLETE : TransferStatus.FAILED;
  }

  /**
   * Waits until the Transfer is completed or failed by polling the Network at the given interval.
   *
   * @param intervalSeconds - The interval at which to poll the Network, in seconds.
   * @param timeoutSeconds - The maximum amount of time to wait for the Transfer to complete, in seconds.
   * @returns The completed Transfer object.
   * @throws {Error} if the Transfer takes longer than the given timeout.
   */
  public async wait(intervalSeconds = 0.2, timeoutSeconds = 10): Promise<Transfer> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutSeconds * 1000) {
      const status = await this.getStatus();
      if (status === TransferStatus.COMPLETE || status === TransferStatus.FAILED) {
        return this;
      }
      await delay(intervalSeconds);
    }
    throw new Error("Transfer timed out");
  }

  /**
   * Returns the link to the Transaction on the blockchain explorer.
   *
   * @returns The link to the Transaction on the blockchain explorer.
   */
  public getTransactionLink(): string {
    return `https://sepolia.basescan.org/tx/${this.getTransactionHash()}`;
  }

  /**
   * Returns a string representation of the Transfer.
   *
   * @returns The string representation of the Transfer.
   */
  public async toString(): Promise<string> {
    const status = await this.getStatus();
    return (
      `Transfer{transferId: '${this.getId()}', networkId: '${this.getNetworkId()}', ` +
      `fromAddressId: '${this.getFromAddressId()}', destinationAddressId: '${this.getDestinationAddressId()}', ` +
      `assetId: '${this.getAssetId()}', amount: '${this.getAmount()}', transactionHash: '${this.getTransactionHash()}', ` +
      `transactionLink: '${this.getTransactionLink()}', status: '${status}'}`
    );
  }
}
