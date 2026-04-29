import './Header.css'

export default function Header() {
  return (
    <header className="header">
      <div className="header-inner">
        <div className="brand">
          <div className="brand-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.55a11 11 0 0 1 14.08 0" />
              <path d="M1.42 9a16 16 0 0 1 21.16 0" />
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
              <circle cx="12" cy="20" r="1" fill="currentColor" />
            </svg>
          </div>
          <div>
            <div className="brand-name">NetProvision</div>
            <div className="brand-sub">Network Device Management</div>
          </div>
        </div>
        <div className="header-status">
          <span className="status-dot" />
          <span className="status-text">Core Network Online</span>
        </div>
      </div>
    </header>
  )
}
