import { useState, useEffect, useCallback, useRef } from 'react';
import type { AppState, WebSocketMessage, ActionMessage } from '../types';

const RECONNECT_DELAY = 3000;

/** Close code sent by server when token is invalid or expired - do not reconnect. */
const WS_CLOSE_AUTH_FAILED = 4001;

export type UseWebSocketOptions = {
  /** Called when server closes with auth failure (e.g. 4001). Use to clear token and redirect to login. */
  onAuthFailure?: () => void;
  /** Called when server pushes a new call notification (so UI can refresh count). */
  onCallNotificationNew?: () => void;
  /** Called when the server pushes a call's status at hangup (`call_outcome`). */
  onCallOutcome?: (msg: { extension: string; status: string; linkedid: string }) => void;
};

/**
 * The socket URL. The token never goes in it (URLs end up in proxy and access logs);
 * it is sent as the first frame instead, which the server reads when the query has none.
 * In dev, set VITE_API_ORIGIN (e.g. http://172.16.11.65:8765) to connect WS directly to
 * the backend when the proxy fails.
 */
function getWsUrl(): string {
  const apiOrigin = import.meta.env.VITE_API_ORIGIN as string | undefined;
  let wsBase: string;
  if (apiOrigin) {
    wsBase = apiOrigin.replace(/^http/, 'ws');
    if (wsBase.endsWith('/')) wsBase = wsBase.slice(0, -1);
  } else {
    const base = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase = `${protocol}//${base}`;
  }
  return `${wsBase}/ws`;
}

/**
 * The app's live-state socket.
 *
 * Authenticates with `{token}` as the first frame. The callbacks are read through a ref,
 * so a parent re-render with new callback identities never tears the socket down (it
 * used to: every new `onCallNotificationNew` reconnected). A deliberate teardown drops
 * the handlers before closing, so a late `onclose` cannot schedule a reconnect for a
 * session that has been left.
 */
export function useWebSocket(token: string | null, options: UseWebSocketOptions = {}) {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [notifications, setNotifications] = useState<string[]>([]);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  // Latched by teardown (unmount / logout). While set, neither a pending reconnect timer
  // nor a late onclose may open another socket.
  const stoppedRef = useRef(false);

  const addNotification = useCallback((message: string) => {
    setNotifications(prev => [...prev.slice(-4), message]);
    // Auto-remove after 5 seconds
    setTimeout(() => {
      setNotifications(prev => prev.slice(1));
    }, 5000);
  }, []);

  const connect = useCallback(() => {
    if (stoppedRef.current || !token) return;
    // Also bail while a socket is still CONNECTING, otherwise a reconnect timer that fires
    // mid-handshake leaves two sockets for one session.
    const existing = wsRef.current?.readyState;
    if (existing === WebSocket.OPEN || existing === WebSocket.CONNECTING) return;

    try {
      const ws = new WebSocket(getWsUrl());

      ws.onopen = () => {
        ws.send(JSON.stringify({ token }));
        console.log('WebSocket connected');
        setConnected(true);
        addNotification('Connected to server');
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          const opts = optionsRef.current;

          if (message.type === 'initial_state' || message.type === 'state_update') {
            if (message.data) {
              setState(message.data);
              setLastUpdate(new Date());
            }
          } else if (message.type === 'call_notification_new') {
            opts.onCallNotificationNew?.();
          } else if (message.type === 'call_outcome') {
            opts.onCallOutcome?.({
              extension: String(message.extension ?? ''),
              status: String(message.status ?? ''),
              linkedid: String(message.linkedid ?? ''),
            });
          } else if (message.type === 'action_result') {
            if (message.message) {
              addNotification(message.success === false ? `✗ ${message.message}` : `✓ ${message.message}`);
            }
          } else if (message.type === 'error') {
            addNotification(`Error: ${message.message}`);
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      ws.onclose = (event) => {
        console.log('WebSocket disconnected', event.code ? `(code ${event.code})` : '');
        setConnected(false);
        wsRef.current = null;
        if (stoppedRef.current) return;

        if (event.code === WS_CLOSE_AUTH_FAILED) {
          optionsRef.current.onAuthFailure?.();
          return;
        }

        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = window.setTimeout(() => {
          reconnectTimeoutRef.current = null;
          console.log('Attempting to reconnect...');
          connect();
        }, RECONNECT_DELAY);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      wsRef.current = ws;
    } catch (e) {
      console.error('Failed to create WebSocket:', e);
    }
  }, [token, addNotification]);

  const sendAction = useCallback((action: ActionMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(action));
    } else {
      addNotification('Not connected to server');
    }
  }, [addNotification]);

  /** Close the socket and cancel any pending reconnect, for good. */
  const disconnect = useCallback(() => {
    stoppedRef.current = true;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(1000, 'client teardown'); } catch { /* already closing */ }
    }
    setConnected(false);
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    state,
    connected,
    lastUpdate,
    notifications,
    sendAction,
    disconnect,
  };
}
