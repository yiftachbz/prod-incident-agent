import { useState } from 'react'

const API_BASE = import.meta.env.VITE_API_URL ?? ''
import Header from './components/Header.jsx'
import ProvisionForm from './components/ProvisionForm.jsx'
import DeviceList from './components/DeviceList.jsx'
import ErrorBanner from './components/ErrorBanner.jsx'
import './App.css'

const INITIAL_DEVICES = [
  { id: 'DEV-4021', name: 'SF Core Node', segment: '5G SA', zipCode: '94105', status: 'Active', provisionedAt: '2026-04-20 09:10' },
  { id: 'DEV-4035', name: 'Chicago Hub', segment: '5G NSA', zipCode: '60601', status: 'Active', provisionedAt: '2026-04-22 14:45' },
]

export default function App() {
  const [devices, setDevices] = useState(INITIAL_DEVICES)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [successId, setSuccessId] = useState(null)

  async function handleProvision(formData) {
    setError(null)
    setSuccessId(null)
    setLoading(true)

    try {
      const res = await fetch(`${API_BASE}/api/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })

      const data = await res.json()

      if (!res.ok || !data.ok) {
        setError({ status: res.status, ...data })
        return
      }

      setDevices(prev => [data.device, ...prev])
      setSuccessId(data.device.id)
    } catch (err) {
      setError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: 'Could not reach the provisioning server.',
        detail: err.message,
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <Header />
      <main className="main">
        <div className="layout">
          <section className="panel panel-left">
            <div className="panel-title">Provision 5G Device</div>
            <ProvisionForm onSubmit={handleProvision} loading={loading} />
            {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
          </section>
          <section className="panel panel-right">
            <div className="panel-title">
              Provisioned Devices
              <span className="device-count">{devices.length}</span>
            </div>
            <DeviceList devices={devices} highlightId={successId} />
          </section>
        </div>
      </main>
    </div>
  )
}
