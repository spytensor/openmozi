import { useState, useEffect, useRef, useCallback } from "react";
import type { ConnectionStatus, WSInboundMessage, WSOutboundMessage } from "@/types";

interface UseWebSocketOptions {
  onMessage: (msg: WSInboundMessage) => void;
  enabled?: boolean;
}

export function useWebSocket({ onMessage, enabled = true }: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const heartbeatRef = useRef<ReturnType<typeof setInterval>>();
  const onMessageRef = useRef(onMessage);
  const enabledRef = useRef(enabled);
  const shouldReconnectRef = useRef(false);
  onMessageRef.current = onMessage;
  enabledRef.current = enabled;

  const connect = useCallback(() => {
    if (!enabledRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    shouldReconnectRef.current = true;
    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      setConnectionEpoch((epoch) => epoch + 1);
      retriesRef.current = 0;
      // Send hello
      ws.send(JSON.stringify({
        type: "hello",
        client: "mozi-ui",
        capabilities: ["streaming_v1", "workspace_v1", "artifact_v1", "execution_v1", "session_subscription_v1"],
      }));
      // Heartbeat
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 25000);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WSInboundMessage;
        onMessageRef.current(msg);
      } catch (err) {
        // A malformed frame must not kill the socket, but it must not vanish
        // silently either — that reads as "the UI lost my data".
        console.warn("[ws] dropped malformed message", err, e.data?.slice?.(0, 200));
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      clearInterval(heartbeatRef.current);
      if (!enabledRef.current || !shouldReconnectRef.current) return;
      // Reconnect with backoff
      const delay = Math.min(1000 * 2 ** retriesRef.current, 30000);
      retriesRef.current++;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  const send = useCallback((msg: WSOutboundMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    clearTimeout(timerRef.current);
    clearInterval(heartbeatRef.current);
    retriesRef.current = 0;
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
  }, []);

  useEffect(() => {
    if (enabled) connect();
    else disconnect();
    return disconnect;
  }, [connect, disconnect, enabled]);

  return { status, send, disconnect, connectionEpoch };
}
