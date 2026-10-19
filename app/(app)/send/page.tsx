'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, ApiError, type Balance, type FeeEstimate, type Remittance } from '@/lib/api'
import { formatStroops, isWholeKobo, parseAmountToStroops } from '@/lib/money'
import { useAuthenticatedSession } from '@/components/session-provider'
import { getExplorerTxUrl } from '@/lib/utils/network'
import { Plus } from 'lucide-react'

const ASSETS = ['XLM', 'cNGN']
const STELLAR_ADDRESS_LENGTH = 56
const STORAGE_KEY = 'aframp_contacts'

interface Contact {
  id: string
  name: string
  address: string
  createdAt: string
}

interface SendState {
  address: string
  amount: string
  asset: string
  memo: string
  error: string | null
  feeEstimate: FeeEstimate | null
  loadingFee: boolean
  feeError: boolean
  submitting: boolean
  remittances: Remittance[]
  showContacts: boolean
  contacts: Contact[]
}

const STATUS_LABEL: Record<Remittance['status'], string> = {
  pending: 'Pending',
  submitted: 'Submitted',
  confirmed: 'Confirmed',
  failed: 'Failed',
}

export default function SendPage() {
  const { token } = useAuthenticatedSession()
  const searchParams = useSearchParams()
  const [balances, setBalances] = useState<Balance[] | null>(null)
  const [state, setState] = useState<SendState>({
    address: searchParams.get('to') ?? '',
    amount: '',
    asset: 'XLM',
    memo: '',
    error: null,
    feeEstimate: null,
    loadingFee: false,
    feeError: false,
    submitting: false,
    remittances: [],
    showContacts: false,
    contacts: [],
  })

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [nextBalances, nextRemittances] = await Promise.all([
          api.getBalances(token, signal),
          api.listRemittances(token, 20, signal),
        ])
        setBalances(nextBalances)
        setState((prev) => ({ ...prev, remittances: nextRemittances }))
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        if (cause instanceof ApiError && cause.status === 0) throw cause
        setState((prev) => ({
          ...prev,
          error: cause instanceof Error ? cause.message : 'Could not load your send details',
        }))
        setBalances([])
      }
    },
    [token]
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  // Load contacts from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Contact[]
        setState((prev) => ({ ...prev, contacts: parsed }))
      }
    } catch (error) {
      console.error('Failed to load contacts:', error)
    }
  }, [])

  // Load fee estimate when amount or asset changes
  useEffect(() => {
    const stroops = parseAmountToStroops(state.amount)
    if (stroops === null || stroops <= 0n) {
      setState((prev) => ({ ...prev, feeEstimate: null, feeError: false }))
      return
    }

    const loadFee = async () => {
      setState((prev) => ({ ...prev, loadingFee: true, feeError: false }))
      try {
        const estimate = await api.getRemittanceFeeEstimate(token, stroops, state.asset)
        setState((prev) => ({ ...prev, feeEstimate: estimate, loadingFee: false }))
      } catch {
        // A failed estimate must never block the send: fall back to the plain
        // amount and let the user know the fee could not be fetched (#708).
        setState((prev) => ({ ...prev, feeEstimate: null, loadingFee: false, feeError: true }))
      }
    }

    const timer = setTimeout(loadFee, 500)
    return () => clearTimeout(timer)
  }, [state.amount, state.asset, token])

  const available = balances?.find((balance) => balance.asset === state.asset)?.available ?? 0n
  const stroops = parseAmountToStroops(state.amount)

  function validateAddress(): boolean {
    if (state.address.length !== STELLAR_ADDRESS_LENGTH) return false
    if (!state.address.startsWith('G')) return false
    return /^[A-Z0-9]{56}$/.test(state.address)
  }

  function validate(): string | null {
    if (!state.address) return 'Enter recipient address.'
    if (!validateAddress())
      return 'Recipient address must be a valid 56-character Stellar address starting with G.'
    if (stroops === null || stroops <= 0n) return 'Enter an amount to send.'
    if (!isWholeKobo(stroops)) return 'Amount must be a whole number of stroops.'
    if (stroops > available) return 'That is more than your available balance.'
    return null
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const problem = validate()
    if (problem) {
      setState((prev) => ({ ...prev, error: problem }))
      return
    }

    setState((prev) => ({ ...prev, submitting: true, error: null }))
    try {
      await api.createRemittance(
        token,
        state.address,
        stroops!,
        state.asset,
        state.memo || undefined
      )
      setState((prev) => ({
        ...prev,
        address: '',
        amount: '',
        memo: '',
        feeEstimate: null,
        feeError: false,
        error: null,
      }))
      await load()
    } catch (cause) {
      setState((prev) => ({
        ...prev,
        error: cause instanceof Error ? cause.message : 'Send failed',
      }))
    } finally {
      setState((prev) => ({ ...prev, submitting: false }))
    }
  }

  if (!balances) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }

  const totalAmount = state.feeEstimate ? state.feeEstimate.total_stroops : stroops

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Send money</h1>
          <p className="text-dim mt-1 text-sm">
            {formatStroops(available)} {state.asset} available
          </p>
        </div>
        <Link href="/contacts">
          <Button variant="secondary" size="sm" className="gap-2">
            <Plus className="size-4" />
            Contacts
          </Button>
        </Link>
      </header>

      <div className="mt-6 max-w-xl space-y-5">
        <form
          onSubmit={submit}
          className="bg-panel border-hairline flex flex-col gap-4 rounded-2xl border p-5"
        >
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="asset">Asset</Label>
            <Select
              value={state.asset}
              onValueChange={(asset) => setState((prev) => ({ ...prev, asset }))}
            >
              <SelectTrigger id="asset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSETS.map((asset) => (
                  <SelectItem key={asset} value={asset}>
                    {asset}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">Recipient Stellar address</Label>
            <div className="relative">
              <Input
                id="address"
                placeholder="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                value={state.address}
                onChange={(event) =>
                  setState((prev) => ({ ...prev, address: event.target.value.trim() }))
                }
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="amount">Amount ({state.asset})</Label>
            <Input
              id="amount"
              inputMode="decimal"
              placeholder="0.00"
              value={state.amount}
              onChange={(event) => setState((prev) => ({ ...prev, amount: event.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="memo">Memo (optional)</Label>
            <Input
              id="memo"
              placeholder="Add a note"
              value={state.memo}
              onChange={(event) => setState((prev) => ({ ...prev, memo: event.target.value }))}
            />
          </div>

          {state.loadingFee && (
            <p className="text-dim text-sm">Estimating fee…</p>
          )}
          {state.feeError && (
            <p className="text-dim text-sm">Could not estimate the fee. You can still send.</p>
          )}
          {state.feeEstimate && (
            <div className="text-dim flex justify-between text-sm">
              <span>Fee</span>
              <span>{formatStroops(state.feeEstimate.fee_stroops)} {state.asset}</span>
            </div>
          )}
          {totalAmount !== null && totalAmount > 0n && (
            <div className="flex justify-between text-sm font-medium">
              <span>Total</span>
              <span>{formatStroops(totalAmount)} {state.asset}</span>
            </div>
          )}

          <Button type="submit" disabled={state.submitting}>
            {state.submitting ? 'Sending…' : 'Send'}
          </Button>
        </form>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Recent sends</h2>
          {state.remittances.length === 0 ? (
            <p className="text-dim text-sm">No sends yet.</p>
          ) : (
            <ul className="space-y-2">
              {state.remittances.map((remittance) => (
                <li
                  key={remittance.id}
                  className="bg-panel border-hairline flex items-center justify-between gap-3 rounded-xl border p-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {formatStroops(remittance.amount_stroops)} {remittance.asset}
                    </p>
                    <p className="text-dim truncate text-xs">{remittance.recipient_address}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={remittance.status === 'failed' ? 'destructive' : 'secondary'}>
                      {STATUS_LABEL[remittance.status]}
                    </Badge>
                    {remittance.tx_hash && (
                      <a
                        href={getExplorerTxUrl(remittance.tx_hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs underline"
                      >
                        Receipt
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
