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
};

/** In dev, set VITE_API_ORIGIN (e.g. http://172.16.11.65:8765) to connect WS directly to backend when proxy fails. */
function getWsUrl(token: string | null): string | null {
  if (!token) return null;
  const apiOrigin = import.meta.env.VITE_API_ORIGIN as string | undefined;
  let wsBase: string;
  if (apiOrigin) {
    // Connect directly to backend (e.g. ws://172.16.11.65:8765)
    wsBase = apiOrigin.replace(/^http/, 'ws');
    if (wsBase.endsWith('/')) wsBase = wsBase.slice(0, -1);
  } else {
    const base = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase = `${protocol}//${base}`;
  }
  return `${wsBase}/ws?token=${encodeURIComponent(token)}`;
}

export function useWebSocket(token: string | null, options: UseWebSocketOptions = {}) {
  const { onAuthFailure, onCallNotificationNew } = options;
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [notifications, setNotifications] = useState<string[]>([]);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const addNotification = useCallback((message: string) => {
    setNotifications(prev => [...prev.slice(-4), message]);
    // Auto-remove after 5 seconds
    setTimeout(() => {
      setNotifications(prev => prev.slice(1));
    }, 5000);
  }, []);

  const connect = useCallback(() => {
    const url = getWsUrl(token);
    if (!url || wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        // Send token in first message so server can auth if proxy stripped query string
        if (token) ws.send(JSON.stringify({ token }));
        console.log('WebSocket connected');
        setConnected(true);
        addNotification('Connected to server');
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          
          if (message.type === 'initial_state' || message.type === 'state_update') {
            if (message.data) {
              setState(message.data);
              setLastUpdate(new Date());
            }
          } else if (message.type === 'call_notification_new') {
            onCallNotificationNew?.();
          } else if (message.type === 'action_result') {
            if (message.message) {
              addNotification(message.success ? `✓ ${message.message}` : `✗ ${message.message}`);
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

        if (event.code === WS_CLOSE_AUTH_FAILED) {
          onAuthFailure?.();
          return;
        }

        // Reconnect after delay
        reconnectTimeoutRef.current = window.setTimeout(() => {
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
  }, [token, addNotification, onAuthFailure, onCallNotificationNew]);

  const sendAction = useCallback((action: ActionMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(action));
    } else {
      addNotification('Not connected to server');
    }
  }, [addNotification]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (token) connect();
    return () => disconnect();
  }, [token, connect, disconnect]);

  return {
    state,
    connected,
    lastUpdate,
    notifications,
    sendAction,
  };
}

