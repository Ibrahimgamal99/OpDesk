import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BookUser, UserPlus, Pencil, Trash2, Save, Loader2, CheckCircle2, AlertCircle,
  Phone, PhoneCall, Search, Building2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, getUser } from '../auth';
import { useWebPhoneContext } from '../contexts/WebPhoneContext';
import type { Contact } from '../types';

export interface ContactsPanelProps {
  /** Start a call to this number (fills the softphone dialer and opens it). */
  onDial?: (phone: string) => void;
}

const EMPTY_FORM = { name: '', phone: '', company: '', notes: '' };

export function ContactsPanel({ onDial }: ContactsPanelProps) {
  const { t } = useTranslation();
  const isAdmin = getUser()?.role === 'admin';
  const { canConnect } = useWebPhoneContext();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [subTab, setSubTab] = useState<'list' | 'create'>('list');
  const [editing, setEditing] = useState<Contact | null>(null);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/api/contacts');
      if (res.ok) {
        const d = await res.json();
        setContacts(d.contacts || []);
      } else {
        setMessage({ type: 'error', text: t('contacts.loadError') });
      }
    } catch {
      setMessage({ type: 'error', text: t('contacts.loadError') });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(c =>
      c.name.toLowerCase().includes(q)
      || c.phone.toLowerCase().includes(q)
      || (c.company || '').toLowerCase().includes(q));
  }, [contacts, search]);

  const resetForm = useCallback(() => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSubTab('list');
  }, []);

  const startEdit = (c: Contact) => {
    setEditing(c);
    setForm({ name: c.name, phone: c.phone, company: c.company || '', notes: c.notes || '' });
    setSubTab('create');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (!form.name.trim()) {
      setMessage({ type: 'error', text: t('contacts.nameRequired') });
      return;
    }
    if (!form.phone.replace(/\D/g, '')) {
      setMessage({ type: 'error', text: t('contacts.phoneRequired') });
      return;
    }
    try {
      const res = await fetchWithAuth(editing ? `/api/contacts/${editing.id}` : '/api/contacts', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          phone: form.phone.trim(),
          company: form.company.trim() || null,
          notes: form.notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || t('contacts.saveError'));
      }
      setMessage({ type: 'success', text: editing ? t('contacts.updated') : t('contacts.created') });
      resetForm();
      loadContacts();
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('contacts.saveError') });
    }
  };

  const handleDelete = async (c: Contact) => {
    if (!window.confirm(t('contacts.deleteConfirm', { name: c.name }))) return;
    setMessage(null);
    try {
      const res = await fetchWithAuth(`/api/contacts/${c.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || t('contacts.deleteError'));
      }
      setMessage({ type: 'success', text: t('contacts.deleted') });
      if (editing?.id === c.id) resetForm();
      loadContacts();
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('contacts.deleteError') });
    }
  };

  if (loading) {
    return (
      <div className="panel">
        <div className="panel-content" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 64 }}>
          <Loader2 size={32} className="spinner" />
          <p style={{ marginTop: 20, color: 'var(--text-secondary)', fontSize: 14 }}>{t('contacts.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">
          <BookUser size={16} className="panel-title-icon" />
          {t('contacts.title')}
        </h2>
        {isAdmin && (
          <div className="panel-header-actions">
            <div className="up-tabs up-tabs-inline">
              <button
                type="button"
                className={`up-tab ${subTab === 'create' ? 'active' : ''}`}
                onClick={() => setSubTab('create')}
              >
                <UserPlus size={14} />
                {editing ? t('contacts.editContact') : t('contacts.addContact')}
              </button>
              <button
                type="button"
                className={`up-tab ${subTab === 'list' ? 'active' : ''}`}
                onClick={() => setSubTab('list')}
              >
                <BookUser size={14} />
                {t('contacts.title')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="panel-content">
        {message && (
          <div className={`up-alert ${message.type === 'success' ? 'success' : 'error'}`}>
            {message.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            <span>{message.text}</span>
          </div>
        )}

        {subTab === 'create' && isAdmin && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon">
                {editing ? <Pencil size={24} /> : <UserPlus size={24} />}
              </div>
              <div>
                <h2 className="up-add-title">{editing ? t('contacts.editContact') : t('contacts.addContact')}</h2>
                <p className="up-add-desc">{t('contacts.formDesc')}</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="up-add-body">
              <div className="up-form-row">
                <div className="up-form-group">
                  <label>{t('contacts.name')}</label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={t('contacts.namePlaceholder')}
                  />
                </div>
                <div className="up-form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Phone size={14} />
                    {t('contacts.phone')}
                  </label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.phone}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder={t('contacts.phonePlaceholder')}
                  />
                </div>
              </div>
              <div className="up-form-row">
                <div className="up-form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Building2 size={14} />
                    {t('contacts.company')}
                  </label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.company}
                    onChange={e => setForm(f => ({ ...f, company: e.target.value }))}
                    placeholder={t('contacts.companyPlaceholder')}
                  />
                </div>
                <div className="up-form-group">
                  <label>{t('contacts.notes')}</label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder={t('contacts.notesPlaceholder')}
                  />
                </div>
              </div>

              <div className="up-actions">
                <button type="submit" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Save size={16} />
                  {editing ? t('contacts.updateContact') : t('contacts.addContact')}
                </button>
                <button type="button" className="btn" onClick={resetForm}>
                  {t('contacts.cancel')}
                </button>
              </div>
            </form>
          </div>
        )}

        {subTab === 'list' && (
          <>
            <div style={{ position: 'relative', maxWidth: 340, marginBottom: 16 }}>
              <Search size={14} style={{ position: 'absolute', insetInlineStart: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                className="form-input"
                style={{ paddingInlineStart: 32 }}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('contacts.searchPlaceholder')}
              />
            </div>

            {filtered.length === 0 ? (
              <div className="up-empty">
                {contacts.length === 0 ? t('contacts.noContacts') : t('contacts.noMatches')}
              </div>
            ) : (
              <div className="up-users-list">
                {filtered.map(c => (
                  <div key={c.id} className="up-user-card">
                    <div className="up-user-avatar">{(c.name[0] || '?').toUpperCase()}</div>
                    <div className="up-user-info">
                      <div className="up-user-name">{c.name}</div>
                      <div className="up-user-meta">
                        {[c.phone, c.company].filter(Boolean).join(' · ')}
                      </div>
                      {c.notes && (
                        <div className="up-user-meta" style={{ fontStyle: 'italic' }}>{c.notes}</div>
                      )}
                      <div className="up-user-badges">
                        <span className={`contact-src-badge ${c.source}`}>
                          {c.source === 'crm' ? t('contacts.sourceCrm') : t('contacts.sourceManual')}
                        </span>
                      </div>
                    </div>
                    <div className="up-user-actions">
                      {onDial && canConnect && (
                        <button
                          type="button"
                          className="btn btn-edit"
                          onClick={() => onDial(c.phone)}
                          title={t('contacts.call', { name: c.name })}
                        >
                          <PhoneCall size={14} />
                        </button>
                      )}
                      {isAdmin && (
                        <>
                          <button type="button" className="btn btn-edit" onClick={() => startEdit(c)} title={t('contacts.editContact')}>
                            <Pencil size={14} />
                          </button>
                          <button type="button" className="btn btn-delete" onClick={() => handleDelete(c)} title={t('contacts.deleteConfirm', { name: c.name })}>
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
