import type { SyncFailureReason } from '../../shared/ipc'
import { redactError } from '../installer/errors'

/**
 * Classify a git failure into a Registry SyncFailureReason.
 *
 * GitHub cannot be trusted to distinguish "missing" from "no access": a private
 * or non-existent repo both surface as not-found / auth failures. We map that
 * whole ambiguous class to `access-required` and never claim to have diagnosed
 * authentication. Genuine connectivity failures map to `offline`.
 */
export function classifyGitError(
  message: string
): Extract<SyncFailureReason, 'offline' | 'access-required'> {
  if (
    /Authentication failed|could not read Username|Invalid username or password|terminal prompts disabled|403|401|Repository not found|repository not found|access denied|Permission denied \(publickey\)/i.test(
      message
    )
  ) {
    return 'access-required'
  }
  return 'offline'
}

/** Human-facing message for an access-required failure (no auth claim). */
export const ACCESS_REQUIRED_MESSAGE = 'Repository not found or access required'

/**
 * Redact a raw git error before it is surfaced: strip embedded credential
 * material from remote URLs and absolute user paths, then bound the length.
 */
export function redactGitError(message: string): string {
  const withoutCredentials = message.replace(
    /(https?:\/\/|ssh:\/\/|git:\/\/)[^@\s/]+(?::[^@\s/]+)?@/gi,
    '$1'
  )
  return redactError(withoutCredentials)
}
