import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Plugin to suppress ECONNREFUSED errors from WebSocket proxy
function suppressWsProxyErrors(): Plugin {
  return {
    name: 'suppress-ws-proxy-errors',
    configureServer(server) {
      // Intercept Vite's logger to suppress WebSocket proxy ECONNREFUSED errors
      const originalError = console.error
      const originalWarn = console.warn
      
      const shouldSuppress = (args: any[]): boolean => {
        const firstArg = args[0]
        if (typeof firstArg === 'string') {
          return (
            firstArg.includes('[vite] ws proxy error') &&
            firstArg.includes('ECONNREFUSED')
          )
        }
        // Check for AggregateError with ECONNREFUSED
        return args.some(
          (arg: any) =>
            arg?.code === 'ECONNREFUSED' ||
            arg?.message?.includes('ECONNREFUSED') ||
            (arg?.constructor?.name === 'AggregateError' &&
             arg?.errors?.some((e: any) => e?.code === 'ECONNREFUSED'))
        )
      }
      
      console.error = (...args: any[]) => {
        if (shouldSuppress(args)) {
          // Silently ignore - backend may not be ready yet during startup
          return
        }
        originalError.apply(console, args)
      }
      
      console.warn = (...args: any[]) => {
        if (shouldSuppress(args)) {
          // Silently ignore - backend may not be ready yet during startup
          return
        }
        originalWarn.apply(console, args)
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    suppressWsProxyErrors(),
  ],
  server: {
    port: 3000,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8765',
        ws: true,
        changeOrigin: true,
        secure: false,
        configure: (proxy, _options) => {
          proxy.on('error', (err: any, _req, _res) => {
            // Suppress connection refused errors - backend may not be ready yet
            // These are expected during startup or when backend is restarting
            const isConnectionRefused =
              err?.code === 'ECONNREFUSED' ||
              err?.message?.includes('ECONNREFUSED') ||
              (err?.constructor?.name === 'AggregateError' &&
                err?.errors?.some((e: any) => e?.code === 'ECONNREFUSED'))
            
            if (!isConnectionRefused) {
              console.error('WebSocket proxy error:', err)
            }
            // Silently handle ECONNREFUSED - backend will be ready soon
          })
        },
      },
      '/api': {
        target: 'http://localhost:8765',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})

