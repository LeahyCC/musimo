import { useEffect, useMemo, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { z } from 'zod'

import { api, label4aClipsSchema } from '../../api'
import type { Label4AAnswer, Label4ASection } from '../../api'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner } from '../../ui'

const CLIPS_KEY = ['label-4a-clips'] as const

const EMPTY_ANSWER: Label4AAnswer = {
  sections_played: [],
  vocals: null,
  intensity: null,
  speech: null,
  dnb: null,
  dnb_subtype: null,
}

function isComplete(answer: Label4AAnswer): boolean {
  return (
    answer.vocals != null &&
    answer.intensity != null &&
    answer.speech != null &&
    answer.dnb != null &&
    (answer.dnb !== 'yes' || answer.dnb_subtype != null)
  )
}

function ChoiceRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: string; label: string }[]
  value: string | null
  onChange: (value: string) => void
}) {
  return (
    <div className="grid gap-[10px]">
      <p className="text-body font-medium">{label}</p>
      <div className="flex flex-wrap gap-[8px]">
        {options.map((option) => {
          const selected = value === option.value
          return (
            <Button
              key={option.value}
              variant={selected ? 'primary' : 'default'}
              className="min-h-[48px] flex-1 text-base"
              onClick={() => onChange(option.value)}
              aria-pressed={selected}
            >
              {option.label}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function SectionButton({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant={selected ? 'primary' : 'default'}
      className="min-h-[48px] flex-1 text-base"
      onClick={onClick}
      aria-pressed={selected}
    >
      {label}
    </Button>
  )
}

export function Label4APage() {
  const queryClient = useQueryClient()
  const clips = useQuery({
    queryKey: CLIPS_KEY,
    queryFn: ({ signal }) => api('label-4a/clips', label4aClipsSchema, { signal }),
  })

  const [index, setIndex] = useState(0)
  const [section, setSection] = useState<Label4ASection>('middle')
  const [localAnswer, setLocalAnswer] = useState<Label4AAnswer>(EMPTY_ANSWER)

  const order = clips.data?.order ?? []
  const clipId = order[index]
  const total = clips.data?.total ?? 0

  const clipIdKey = clipId ?? ''
  const savedAnswer = clipId ? clips.data?.answers[clipId] : undefined

  const syncAnswer = (next: Label4AAnswer) => {
    setLocalAnswer(next)
    if (!clipId) return
    queryClient.setQueryData(CLIPS_KEY, (old: typeof clips.data | undefined) => {
      if (!old) return old
      return {
        ...old,
        answers: { ...old.answers, [clipId]: next },
      }
    })
  }

  const save = useMutation({
    mutationFn: (answer: Label4AAnswer) =>
      api(`label-4a/answers/${encodeURIComponent(clipIdKey)}`, z.null(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answer),
      }),
  })

  const updateAnswer = (patch: Partial<Label4AAnswer>) => {
    const next = { ...localAnswer, ...patch }
    syncAnswer(next)
    save.mutate(next)
  }

  const chooseSection = (nextSection: Label4ASection) => {
    setSection(nextSection)
    const played = localAnswer.sections_played
    const nextPlayed = played.includes(nextSection) ? played : [...played, nextSection]
    updateAnswer({ sections_played: nextPlayed })
  }

  useEffect(() => {
    setLocalAnswer(savedAnswer ? { ...savedAnswer } : EMPTY_ANSWER)
    setSection('middle')
  }, [clipIdKey])

  const streamUrl = useMemo(() => {
    if (!clipId) return ''
    return `/api/label-4a/clips/${encodeURIComponent(clipId)}?section=${section}`
  }, [clipId, section])

  if (clips.isPending) {
    return (
      <main className="mx-auto max-w-md p-[16px]" role="status">
        <p className="text-muted">Loading clips…</p>
      </main>
    )
  }

  if (clips.isError) {
    return (
      <main className="mx-auto max-w-md p-[16px]">
        <ErrorBanner>
          {clips.error instanceof Error ? clips.error.message : 'Failed to load clips'}
        </ErrorBanner>
      </main>
    )
  }

  if (!clipId) {
    return (
      <main className="mx-auto max-w-md p-[16px]" role="status">
        <p className="text-muted">No label set is loaded.</p>
      </main>
    )
  }

  const canGoBack = index > 0
  const canGoForward = index < order.length - 1

  return (
    <main className="mx-auto max-w-md p-[16px]">
      <div className="mb-[18px] flex items-center justify-between">
        <p className="text-small text-muted">
          Clip {index + 1} of {total}
        </p>
        {save.isPending && <p className="text-small text-muted">Saving…</p>}
      </div>

      <div className="mb-[18px] grid gap-[10px]">
        <p className="text-small font-medium">Section</p>
        <div className="flex gap-[8px]">
          <SectionButton
            label="Early"
            selected={section === 'early'}
            onClick={() => chooseSection('early')}
          />
          <SectionButton
            label="Middle"
            selected={section === 'middle'}
            onClick={() => chooseSection('middle')}
          />
          <SectionButton
            label="Late"
            selected={section === 'late'}
            onClick={() => chooseSection('late')}
          />
        </div>
      </div>

      {streamUrl && (
        <audio
          key={streamUrl}
          src={streamUrl}
          controls
          className="mb-[24px] w-full"
          preload="auto"
        />
      )}

      <div className="mb-[24px] grid gap-[20px]">
        <ChoiceRow
          label="Vocals?"
          options={[
            { value: 'none', label: 'None' },
            { value: 'a_bit', label: 'A bit' },
            { value: 'yes', label: 'Yes' },
            { value: 'unknown', label: '?' },
          ]}
          value={localAnswer.vocals}
          onChange={(vocals) => updateAnswer({ vocals: vocals as Label4AAnswer['vocals'] })}
        />

        <ChoiceRow
          label="Intensity?"
          options={[
            { value: 'calm', label: 'Calm' },
            { value: 'medium', label: 'Medium' },
            { value: 'intense', label: 'Intense' },
            { value: 'unknown', label: '?' },
          ]}
          value={localAnswer.intensity}
          onChange={(intensity) =>
            updateAnswer({ intensity: intensity as Label4AAnswer['intensity'] })
          }
        />

        <ChoiceRow
          label="Speech?"
          options={[
            { value: 'music', label: 'Music' },
            { value: 'speech', label: 'Speech' },
            { value: 'both', label: 'Both' },
            { value: 'unknown', label: '?' },
          ]}
          value={localAnswer.speech}
          onChange={(speech) => updateAnswer({ speech: speech as Label4AAnswer['speech'] })}
        />

        <ChoiceRow
          label="Is it drum and bass?"
          options={[
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' },
            { value: 'unknown', label: '?' },
          ]}
          value={localAnswer.dnb}
          onChange={(dnb) => updateAnswer({ dnb: dnb as Label4AAnswer['dnb'], dnb_subtype: null })}
        />

        {localAnswer.dnb === 'yes' && (
          <ChoiceRow
            label="Which kind?"
            options={[
              { value: 'liquid', label: 'Liquid' },
              { value: 'other', label: 'Other dnb' },
              { value: 'unknown', label: '?' },
            ]}
            value={localAnswer.dnb_subtype}
            onChange={(sub) => updateAnswer({ dnb_subtype: sub as Label4AAnswer['dnb_subtype'] })}
          />
        )}
      </div>

      <div className="flex gap-[10px]">
        <Button
          variant="default"
          className={cx('min-h-[52px] px-[16px]', !canGoBack && 'invisible')}
          onClick={() => canGoBack && setIndex((i) => i - 1)}
          aria-label="Previous clip"
        >
          <ChevronLeft className="size-5" />
        </Button>
        <Button
          variant="primary"
          className="min-h-[52px] flex-1 text-lg"
          onClick={() => {
            if (canGoForward) {
              setIndex((i) => i + 1)
            }
          }}
          disabled={!isComplete(localAnswer)}
        >
          {canGoForward ? 'Save and next' : 'Save'}
        </Button>
      </div>
    </main>
  )
}
