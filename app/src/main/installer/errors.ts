export function redactError(message: string): string {
  return message
    .replace(/\/Users\/[^\s:]+/g, '~')
    .replace(/\/home\/[^\s:]+/g, '~')
    .replace(/\/var\/folders\/[^\s:]+/g, '~')
    .slice(0, 280)
}
