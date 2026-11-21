export class SettingsError extends Error {
  readonly code = "config";
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}
