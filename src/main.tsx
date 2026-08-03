import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { initTvMode } from '@/lib/tv'
import { initTvFocus } from '@/lib/tvFocus'

// TV 模式: ?tv=1 或电视 UA 时启用遥控器方向键导航(非 TV 环境零副作用)
initTvMode()
initTvFocus()

// PWA: 仅生产环境注册 Service Worker(缓存静态构建产物, 行情接口不缓存)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
