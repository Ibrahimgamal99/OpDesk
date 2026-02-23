const TOKEN_KEY = 'opdesk_token';
const USER_KEY = 'opdesk_user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export type User = {
  id: number;
  username: string;
  name?: string;
  role: string;
  extension?: string | null;
  /** Call monitoring modes (multiple): listen, whisper, barge. From DB user_monitor_modes. */
  monitor_modes?: ('listen' | 'whisper' | 'barge')[];
  /** Admin: undefined (see all). Supervisor: list of extension numbers they can see. */
  allowed_agent_extensions?: string[] | null;
  /** Admin: undefined (see all). Supervisor: list of queue names they can see. */
  allowed_queue_names?: string[] | null;
};

export function setUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** True if current user has limited scope (supervisor with groups, or agent seeing only their extension). */
export function isFilteredScope(): boolean {
  const u = getUser();
  if (u?.role === 'agent') return true;
  return u?.role === 'supervisor' && (
    (Array.isArray(u.allowed_agent_extensions) && u.allowed_agent_extensions.length > 0) ||
    (Array.isArray(u.allowed_queue_names) && u.allowed_queue_names.length > 0)
  );
}

/** Human-readable label for a single mode. */
export function getMonitorModeLabel(mode: string | undefined): string {
  switch (mode) {
    case 'listen': return 'Listen';
    case 'whisper': return 'Whisper';
    case 'barge': return 'Barge';
    default: return 'Listen';
  }
}

/** Human-readable label for monitor_modes list (e.g. "Listen, Whisper"). */
export function getMonitorModesLabel(modes: string[] | undefined): string {
  if (!modes || modes.length === 0) return 'Listen';
  const labels = modes.map(m => getMonitorModeLabel(m)).filter(Boolean);
  return labels.length ? labels.join(', ') : 'Listen';
}

/** Which supervisor action buttons to show based on monitor_modes from DB. */
export function getAllowedMonitorModes(): ('listen' | 'whisper' | 'barge')[] {
  const modes = getUser()?.monitor_modes;
  if (Array.isArray(modes) && modes.length > 0) return modes as ('listen' | 'whisper' | 'barge')[];
  return ['listen'];
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

/** Headers for authenticated fetch requests */
export function getAuthHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
