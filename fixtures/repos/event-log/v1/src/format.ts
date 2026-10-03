export function formatEvent(name: string, fields: Record<string, string | number | boolean>): string {
  return JSON.stringify({ name, fields });
}
