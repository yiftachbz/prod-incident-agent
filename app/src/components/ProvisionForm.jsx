import { useState } from 'react'
import './ProvisionForm.css'

const SEGMENTS = ['5G SA', '5G NSA']

export default function ProvisionForm({ onSubmit, loading }) {
  const [form, setForm] = useState({ name: '', segment: '5G SA', zipCode: '' })

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  function handleSubmit(e) {
    e.preventDefault()
    if (!form.name.trim() || !form.zipCode.trim()) return
    onSubmit({ ...form, name: form.name.trim(), zipCode: form.zipCode.trim() })
  }

  const canSubmit = form.name.trim() && form.zipCode.trim() && !loading

  return (
    <form className="provision-form" onSubmit={handleSubmit}>
      <div className="field">
        <label className="field-label">Device Name</label>
        <input
          className="field-input"
          name="name"
          type="text"
          placeholder="e.g. Gateway Node Delta"
          value={form.name}
          onChange={handleChange}
          disabled={loading}
          autoComplete="off"
        />
      </div>

      <div className="field">
        <label className="field-label">Network Segment</label>
        <select
          className="field-select warn"
          name="segment"
          value={form.segment}
          onChange={handleChange}
          disabled={loading}
        >
          {SEGMENTS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="field">
        <label className="field-label">Zip Code</label>
        <input
          className="field-input"
          name="zipCode"
          type="text"
          placeholder="e.g. 94105"
          value={form.zipCode}
          onChange={handleChange}
          disabled={loading}
          autoComplete="off"
          maxLength={10}
        />
        <p className="field-hint">
          Try <strong>94105</strong> (covered) or <strong>10001</strong> (not covered).
        </p>
      </div>

      <button className="submit-btn" type="submit" disabled={!canSubmit}>
        {loading ? (
          <span className="spinner-row">
            <span className="spinner" />
            Provisioning…
          </span>
        ) : (
          'Provision Device'
        )}
      </button>
    </form>
  )
}
