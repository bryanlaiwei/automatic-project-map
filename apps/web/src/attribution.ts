/** GitHub logins compare case-insensitively. */
export function sameGithubLogin(login: string, viewerLogin: string | null): boolean {
  return viewerLogin !== null && login.toLowerCase() === viewerLogin.toLowerCase();
}

export function otherGithubLogins(logins: readonly string[], viewerLogin: string | null): string[] {
  return logins.filter((login) => !sameGithubLogin(login, viewerLogin));
}
