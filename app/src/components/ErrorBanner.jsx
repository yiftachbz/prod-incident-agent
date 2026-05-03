import './ErrorBanner.css'

export default function ErrorBanner({ error, onDismiss }) {
  return (
    <div className="error-banner">
      <div className="error-header">
        <div className="error-title-row">
          <span className="error-icon">⚠</span>
          <span className="error-title">Provisioning Failed</span>
          <span className="error-badge">HTTP 400</span>
        </div>
        <button className="error-close" onClick={onDismiss} aria-label="Dismiss">✕</button>
      </div>

      <div className="error-code">{error.code}</div>
      <p className="error-message">{error.message}</p>
      <p className="error-detail">{error.detail}</p>

      <div className="error-meta">
        <div className="meta-row">
          <span className="meta-key">Segment</span>
          <span className="meta-val">{error.segment}</span>
        </div>
        <div className="meta-row">
          <span className="meta-key">Session ID</span>
          <span className="meta-val">{error.sessionId ?? error.requestId}</span>
        </div>
      </div>
    </div>
  )
}
