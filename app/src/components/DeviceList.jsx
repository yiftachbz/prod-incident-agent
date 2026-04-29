import './DeviceList.css'

const STATUS_COLORS = {
  Active:  { bg: '#052e16', text: '#4ade80', dot: '#22c55e' },
  Pending: { bg: '#1c1917', text: '#fbbf24', dot: '#f59e0b' },
  Error:   { bg: '#1a0a0a', text: '#f87171', dot: '#ef4444' },
}

export default function DeviceList({ devices, highlightId }) {
  if (devices.length === 0) {
    return <div className="device-empty">No devices provisioned yet.</div>
  }

  return (
    <div className="device-list">
      {devices.map(device => {
        const statusStyle = STATUS_COLORS[device.status] || STATUS_COLORS.Pending
        const isNew = device.id === highlightId

        return (
          <div key={device.id} className={`device-row ${isNew ? 'new' : ''}`}>
            <div className="device-row-top">
              <div className="device-id-block">
                <span className="device-id">{device.id}</span>
                <span className="device-name">{device.name}</span>
              </div>
              <span className="device-status" style={{ background: statusStyle.bg, color: statusStyle.text }}>
                <span className="device-status-dot" style={{ background: statusStyle.dot }} />
                {device.status}
              </span>
            </div>
            <div className="device-row-meta">
              <span className="device-segment">{device.segment}</span>
              <span className="device-zip">ZIP {device.zipCode}</span>
              <span className="device-time">{device.provisionedAt}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
