"use client"

import type { FormEvent, ReactNode } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { ButtonLink } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Disclosure } from "@/components/ui/disclosure"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control"
import type { ServerActionResult } from "@/lib/actions/servers"
import { cn } from "@/lib/utils"

/**
 * The pieces the add and edit forms of API endpoints, mail accounts, SSH
 * servers and wrappers share. Adding, a form is a card on its own page, the
 * few things everyone needs first and the rest under "More options".
 * Editing, it sits inside the server page's "Advanced" disclosure, so it is
 * drawn flat, every setting in view: no card in a card, no fold in a fold.
 */

/**
 * A form's frame: a card when adding, plain when editing. A required field
 * folded away under a disclosure opens it when the form is refused, so the
 * browser can show the owner what is missing instead of failing silently.
 */
export function ServerFormFrame({
  editing,
  action,
  children,
}: {
  editing: boolean
  action: (formData: FormData) => void
  children: ReactNode
}) {
  const form = (
    <form
      action={action}
      onInvalidCapture={openFoldedField}
      className="flex flex-col gap-5"
    >
      {children}
    </form>
  )

  return editing ? form : <Card className="gap-5 p-5 sm:p-6">{form}</Card>
}

function openFoldedField(event: FormEvent<HTMLFormElement>) {
  let details = (event.target as HTMLElement).closest("details")

  while (details) {
    details.open = true
    details = details.parentElement?.closest("details") ?? null
  }
}

/** A group of fields under a hairline, after the first. */
export function FormSection({
  title,
  className,
  children,
}: {
  title?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 border-t border-separator pt-5 first-of-type:border-t-0 first-of-type:pt-0",
        className,
      )}
    >
      {title ? (
        <h3 className="text-[13px] font-semibold text-muted-foreground">
          {title}
        </h3>
      ) : null}
      {children}
    </div>
  )
}

/**
 * Name, short name (once it exists) and description: what every server
 * has, and what an assistant reads to choose one.
 */
export function NameFields({
  prefix,
  editing,
  name,
  onNameChange,
  slug,
  onSlugChange,
  description,
  onDescriptionChange,
  namePlaceholder,
  descriptionPlaceholder,
  descriptionHint,
  slugHint,
}: {
  prefix: string
  editing: boolean
  name: string
  onNameChange: (value: string) => void
  slug: string
  onSlugChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  namePlaceholder: string
  descriptionPlaceholder?: string
  descriptionHint: string
  slugHint: string
}) {
  return (
    <>
      <div className={cn("grid gap-4", editing && "sm:grid-cols-2")}>
        <Field label="Name" htmlFor={`${prefix}-name`}>
          <Input
            id={`${prefix}-name`}
            name="name"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            required
            maxLength={80}
            placeholder={namePlaceholder}
          />
        </Field>
        {editing ? (
          <Field label="Short name" htmlFor={`${prefix}-slug`} hint={slugHint}>
            <Input
              id={`${prefix}-slug`}
              name="slug"
              value={slug}
              onChange={(event) => onSlugChange(event.target.value)}
              pattern="[a-z0-9-]+"
              maxLength={40}
              spellCheck={false}
              className="font-mono"
            />
          </Field>
        ) : null}
      </div>
      <Field
        label="Description"
        htmlFor={`${prefix}-description`}
        hint={descriptionHint}
      >
        <Textarea
          id={`${prefix}-description`}
          name="description"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          maxLength={1000}
          rows={2}
          className="min-h-16"
          placeholder={descriptionPlaceholder}
        />
      </Field>
    </>
  )
}

/**
 * Two to four exclusive choices with a label above and a grey line under
 * that says what the chosen one means. The label is the group's legend for
 * assistive technology, so it is shown here only to the eye.
 */
export function ChoiceField<T extends string>({
  label,
  name,
  options,
  value,
  onValueChange,
  hint,
}: {
  label: string
  name: string
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onValueChange: (value: T) => void
  hint?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden className="text-sm leading-none font-medium">
        {label}
      </span>
      <SegmentedControl
        name={name}
        legend={label}
        options={options}
        value={value}
        onValueChange={onValueChange}
        className="self-start"
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** Switch rows on the field colour, so they read as a group inside a card. */
export function SwitchGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-[10px] border border-input bg-field">
      {children}
    </div>
  )
}

/**
 * What most owners never change, folded under one row at the bottom of the
 * add form. Its description names everything inside.
 */
export function MoreOptions({
  description,
  defaultOpen,
  children,
}: {
  description: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <Disclosure
      inList
      title="More options"
      description={description}
      defaultOpen={defaultOpen}
      className="-mx-5 border-y border-separator sm:-mx-6 [&>summary]:px-5 sm:[&>summary]:px-6"
      contentClassName="gap-5 px-5 sm:px-6"
    >
      {children}
    </Disclosure>
  )
}

/** The error or note, and the form's one button (with Cancel, adding). */
export function FormFooter({
  editing,
  state,
  submitLabel,
  pendingText,
}: {
  editing: boolean
  state: ServerActionResult
  submitLabel: string
  pendingText: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {editing ? null : (
          <ButtonLink href="/servers" variant="secondary">
            Cancel
          </ButtonLink>
        )}
        <SubmitButton pendingText={pendingText}>
          {editing ? "Save changes" : submitLabel}
        </SubmitButton>
      </div>
    </div>
  )
}
