export type AuthUser = {
  id: string;
  githubLogin?: string | null;
  /** GitHub's numeric account id, as a decimal string. Unlike the login, it never changes hands. */
  githubId?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
};
