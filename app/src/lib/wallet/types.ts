import type { Base58, Role, WalletSession } from "../types";

/**
 * Wallet interface used by the UI via `useWallet()` from ./context.tsx.
 * The backend agent implements it with Tether WDK (@tetherto/wdk-wallet-solana):
 * seed phrases are generated and kept on the user's device, never sent to our server.
 * In mock mode the same interface is backed by demo personas so the UI works offline.
 */
export interface WalletApi {
  ready: boolean;
  /** The wallet currently acting in the UI. */
  session: WalletSession | null;
  /** All wallets stored on this device (multi-persona for the demo: dad, children, verifiers, buyer). */
  sessions: WalletSession[];
  /** Creates a new self-custodial WDK wallet. Returns the seed phrase ONCE so the UI can show a backup step. */
  create(label: string, role: Role): Promise<{ session: WalletSession; seedPhrase: string }>;
  importSeed(label: string, role: Role, seedPhrase: string): Promise<WalletSession>;
  /**
   * Adds a phone wallet (Wallet Standard; Mobile Wallet Adapter on Android) by its Wallet Standard name, from
   * usePhoneWallets(). The wallet app shows its own approval; only the address is kept. Mock mode: simulated.
   */
  connectPhone(label: string, role: Role, walletName: string): Promise<WalletSession>;
  switchTo(address: Base58): void;
  remove(address: Base58): void;
  refreshBalances(): Promise<void>;
  /** Signs + sends a serialized (base64) Solana transaction with the active wallet (WDK or phone). */
  signAndSend(base64Tx: string): Promise<string>;
}
