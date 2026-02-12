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
      const originalLog = console.log
      
      const shouldSuppress = (args: any[]): boolean => {
        // Check all arguments for ECONNREFUSED indicators
        const errorString = args.map(arg => {
          if (typeof arg === 'string') return arg
          if (arg?.message) return arg.message
          if (arg?.code) return arg.code
          if (arg?.constructor?.name === 'AggregateError') {
            return arg.errors?.map((e: any) => e?.code || e?.message).join(' ')
          }
          return String(arg)
        }).join(' ')
        
        return (
          errorString.includes('ECONNREFUSED') ||
          errorString.includes('ws proxy error') ||
          errorString.includes('afterConnectMultiple') ||
          errorString.includes('internalConnectMultiple')
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
      
      console.log = (...args: any[]) => {
        if (shouldSuppress(args)) {
          // Silently ignore - backend may not be ready yet during startup
          return
        }
        originalLog.apply(console, args)
      }
      
      // Also intercept Vite's internal logger if available
      if (server.config.logger) {
        const originalLoggerError = server.config.logger.error
        const originalLoggerWarn = server.config.logger.warn
        const originalLoggerInfo = server.config.logger.info
        
        server.config.logger.error = (...args: any[]) => {
          if (shouldSuppress(args)) {
            return
          }
          originalLoggerError.apply(server.config.logger, args)
        }
        
        server.config.logger.warn = (...args: any[]) => {
          if (shouldSuppress(args)) {
            return
          }
          originalLoggerWarn.apply(server.config.logger, args)
        }
        
        server.config.logger.info = (...args: any[]) => {
          if (shouldSuppress(args)) {
            return
          }
          originalLoggerInfo.apply(server.config.logger, args)
        }
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
              err?.message?.includes('afterConnectMultiple') ||
              err?.message?.includes('internalConnectMultiple') ||
              (err?.constructor?.name === 'AggregateError' &&
                err?.errors?.some((e: any) => 
                  e?.code === 'ECONNREFUSED' ||
                  e?.message?.includes('ECONNREFUSED')
                ))
            
            if (!isConnectionRefused) {
              console.error('WebSocket proxy error:', err)
            }
            // Silently handle ECONNREFUSED - backend will be ready soon
          })
          
          // Suppress proxy connection errors
          proxy.on('proxyReqWs', () => {
            // Connection attempt started
          })
          
          // Use type assertion to handle proxyReqWsError event
          ;(proxy.on as any)('proxyReqWsError', (err: any, _req: any, _socket: any) => {
            // Suppress WebSocket connection errors
            const isConnectionRefused =
              err?.code === 'ECONNREFUSED' ||
              err?.message?.includes('ECONNREFUSED') ||
              err?.message?.includes('afterConnectMultiple') ||
              err?.message?.includes('internalConnectMultiple') ||
              (err?.constructor?.name === 'AggregateError' &&
                err?.errors?.some((e: any) => 
                  e?.code === 'ECONNREFUSED' ||
                  e?.message?.includes('ECONNREFUSED')
                ))
            
            if (!isConnectionRefused) {
              console.error('WebSocket proxy request error:', err)
            }
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