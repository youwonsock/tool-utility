// The adapter owns its boundary types; building never requires a platform SDK.
export type PermissionResult = {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
};
export interface Query extends AsyncIterable<unknown> {
  initializationResult(): Promise<any>;
  getContextUsage(options: { detail: string }): Promise<any>;
  setModel(model: string): Promise<unknown>;
  interrupt(): Promise<unknown>;
  close(): void;
}
export type Options = Record<string, unknown>;
