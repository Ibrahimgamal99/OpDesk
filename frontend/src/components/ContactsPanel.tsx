import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BookUser, Plus, Pencil, Trash2, Save, Loader2, PhoneCall,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, getUser } from '../auth';
import { useWebPhoneContext } from '../contexts/WebPhoneContext';
import type { Contact } from '../types';
import { raiseFor } from '../lib/api';
import {
  SearchInput, Alert, Page, Toolbar, EmptyState, Badge, type BadgeTone, Table, Modal, Loading,
  FormSection, FormRow, FormField, useConfirm,
} from './ui';

export interface ContactsPanelProps {
  /** Start a call to this number (fills the softphone dialer and opens it). */
  onDial?: (phone: string) => void;
}

const EMPTY_FORM = { name: '', phone: '', company: '', notes: '' };

/**
 * The shared contacts phonebook. Every user reads it and can click to call; only
 * admins see add/edit/delete. The list is loaded whole and searched in the browser.
 */
export function ContactsPanel({ onDial }: ContactsPanelProps) {
  const { t } = useTranslation();
  const [confirm, confirmDialog] = useConfirm();
  const isAdmin = getUser()?.role === 'admin';
  const { canConnect } = useWebPhoneContext();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // The add/edit form is a modal over the list; the list is the only view.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

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
    setFormOpen(false);
  }, []);

  const openCreate = () => {
    setMessage(null);
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const startEdit = (c: Contact) => {
    setMessage(null);
    setEditing(c);
    setForm({ name: c.name, phone: c.phone, company: c.company || '', notes: c.notes || '' });
    setFormOpen(true);
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
    setSaving(true);
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
      if (!res.ok) await raiseFor(res);
      setMessage({ type: 'success', text: editing ? t('contacts.updated') : t('contacts.created') });
      resetForm();
      loadContacts();
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('contacts.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c: Contact) => {
    const ok = await confirm({
      title: t('contacts.deleteTitle', 'Delete contact?'),
      message: t('contacts.deleteConfirm', { name: c.name }),
      confirmLabel: t('common.delete', 'Delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setMessage(null);
    try {
      const res = await fetchWithAuth(`/api/contacts/${c.id}`, { method: 'DELETE' });
      if (!res.ok) await raiseFor(res);
      setMessage({ type: 'success', text: t('contacts.deleted') });
      if (editing?.id === c.id) resetForm();
      loadContacts();
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('contacts.deleteError') });
    }
  };

  const sourceBadge = (source: Contact['source']): { tone: BadgeTone; label: string } => {
    if (source === 'crm') return { tone: 'info', label: t('contacts.sourceCrm') };
    return { tone: 'success', label: t('contacts.sourceManual') };
  };

  return (
    <Page
      icon={BookUser}
      title={t('contacts.title')}
      count={loading ? undefined : contacts.length}
      actions={isAdmin ? (
        <button type="button" className="btn btn-primary" onClick={openCreate}>
          <Plus size={14} />
          {t('contacts.addContact')}
        </button>
      ) : undefined}
      toolbar={
        <Toolbar
          search={
            <SearchInput
              value={search}
              onChange={setSearch}
              label={t('contacts.searchLabel', 'Search contacts')}
              placeholder={t('contacts.searchPlaceholder')}
              // Filters an already-loaded list, so there is no request to coalesce.
              debounceMs={0}
              urlSync={false}
            />
          }
        />
      }
    >
      {/* A form error belongs to the open form, so it shows inside the modal instead. */}
      {message && !(formOpen && message.type === 'error') && (
        <Alert
          tone={message.type === 'success' ? 'success' : 'error'}
          onDismiss={() => setMessage(null)}
        >
          {message.text}
        </Alert>
      )}

      {loading && contacts.length === 0 ? (
        <Loading label={t('contacts.loading')} />
      ) : (
        <Table
          framed
          caption={t('contacts.title')}
          rows={filtered}
          rowKey={c => c.id}
          empty={contacts.length > 0 ? (
            <EmptyState
              icon={BookUser}
              title={t('contacts.noMatchesTitle', 'No matching contacts')}
              description={t('contacts.noMatches')}
            />
          ) : (
            <EmptyState
              icon={BookUser}
              title={t('contacts.emptyTitle', 'No contacts yet')}
              description={t('contacts.noContacts')}
            />
          )}
          columns={[
            {
              key: 'name', header: t('contacts.name'), primary: true,
              cell: c => (
                <div className="u-min-w-0">
                  <div className="u-semibold">{c.name}</div>
                  {c.notes && <div className="u-fg-muted u-text-sm u-truncate">{c.notes}</div>}
                </div>
              ),
            },
            {
              key: 'phone', header: t('contacts.phone'),
              cell: c => <span className="u-mono" dir="ltr">{c.phone}</span>,
            },
            {
              key: 'company', header: t('contacts.company'), hideOnMobile: true,
              cell: c => c.company || '—',
            },
            {
              key: 'source', header: t('contacts.source', 'Source'),
              cell: c => {
                const badge = sourceBadge(c.source);
                return <Badge tone={badge.tone}>{badge.label}</Badge>;
              },
            },
            {
              key: 'actions', header: t('common.actions', 'Actions'), align: 'end',
              cell: c => (
                <div className="u-row u-justify-end u-gap-1">
                  {onDial && canConnect && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon"
                      onClick={() => onDial(c.phone)}
                      title={t('contacts.call', { name: c.name })}
                      aria-label={t('contacts.call', { name: c.name })}
                    >
                      <PhoneCall size={14} />
                    </button>
                  )}
                  {isAdmin && (
                    <>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon"
                        onClick={() => startEdit(c)}
                        title={t('contacts.editContact')}
                        aria-label={t('contacts.editContact')}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-danger btn-sm btn-icon"
                        onClick={() => handleDelete(c)}
                        title={t('common.delete', 'Delete')}
                        aria-label={t('common.delete', 'Delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}

      {isAdmin && (
        <Modal
          open={formOpen}
          onClose={resetForm}
          title={editing ? t('contacts.editContact') : t('contacts.addContact')}
          icon={<BookUser size={16} />}
          width="wide"
          footer={
            <>
              <button type="button" className="btn" onClick={resetForm}>
                {t('contacts.cancel')}
              </button>
              <button type="submit" form="contact-form" className="btn btn-primary" disabled={saving}>
                {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
                {editing ? t('contacts.updateContact') : t('contacts.addContact')}
              </button>
            </>
          }
        >
          <form id="contact-form" onSubmit={handleSubmit}>
            {formOpen && message?.type === 'error' && (
              <Alert className="u-mb-3" onDismiss={() => setMessage(null)}>{message.text}</Alert>
            )}
            <p className="u-fg-muted u-mt-0">{t('contacts.formDesc')}</p>
            <FormSection title={t('contacts.details', 'Details')} first>
              <FormRow>
                <FormField label={t('contacts.name')} htmlFor="contact-name" required>
                  <input
                    id="contact-name"
                    type="text"
                    className="form-input"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={t('contacts.namePlaceholder')}
                  />
                </FormField>
                <FormField label={t('contacts.phone')} htmlFor="contact-phone" required>
                  <input
                    id="contact-phone"
                    type="text"
                    className="form-input"
                    dir="ltr"
                    value={form.phone}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder={t('contacts.phonePlaceholder')}
                  />
                </FormField>
              </FormRow>
              <FormRow>
                <FormField label={t('contacts.company')} htmlFor="contact-company">
                  <input
                    id="contact-company"
                    type="text"
                    className="form-input"
                    value={form.company}
                    onChange={e => setForm(f => ({ ...f, company: e.target.value }))}
                    placeholder={t('contacts.companyPlaceholder')}
                  />
                </FormField>
                <FormField label={t('contacts.notes')} htmlFor="contact-notes">
                  <input
                    id="contact-notes"
                    type="text"
                    className="form-input"
                    value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder={t('contacts.notesPlaceholder')}
                  />
                </FormField>
              </FormRow>
            </FormSection>
          </form>
        </Modal>
      )}
      {confirmDialog}
    </Page>
  );
}
