export function isDesktopRequest(headers: Headers): boolean {
  // Electron sends its runtime version in the default user agent. Use this
  // only to choose the interface; session checks apply to both clients.
  return /\bElectron\/\d/i.test(headers.get("user-agent") ?? "")
}
