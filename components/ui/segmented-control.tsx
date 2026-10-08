"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export type SegmentedOption<T extends string> = {
  value: T
  label: React.ReactNode
  /** Tints the chosen segment: `allow` teal, `block` red. */
  tone?: "allow" | "block"
}

/**
 * A few choices side by side, one chosen: a group of native radio buttons
 * under a legend (read by assistive technology, not shown), so it submits
 * with a form and each option is reachable with the arrow keys. Controlled
 * with `value` and `onValueChange`, or left to the form with `defaultValue`.
 */
function SegmentedControl<T extends string>({
  name,
  legend,
  options,
  value,
  defaultValue,
  onValueChange,
  disabled,
  size = "default",
  className,
}: {
  name: string
  legend: string
  options: ReadonlyArray<SegmentedOption<T>>
  value?: T
  defaultValue?: T
  onValueChange?: (value: T) => void
  disabled?: boolean
  size?: "default" | "sm"
  className?: string
}) {
  const id = React.useId()

  return (
    <fieldset
      disabled={disabled}
      className={cn(
        "m-0 inline-flex min-w-0 flex-wrap gap-0.5 rounded-[9px] border-0 bg-muted p-0.5 disabled:opacity-60",
        className,
      )}
    >
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const optionId = `${id}-${option.value}`

        return (
          <span key={option.value} className="relative flex">
            <input
              type="radio"
              id={optionId}
              name={name}
              value={option.value}
              // Laid over its label, invisible: a click lands on the radio
              // itself, as it would on a plain one (and a test's check()).
              className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
              {...(value !== undefined
                ? { checked: value === option.value }
                : { defaultChecked: defaultValue === option.value })}
              onChange={() => onValueChange?.(option.value)}
            />
            <label
              htmlFor={optionId}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-[7px] px-3 font-medium whitespace-nowrap text-[#aab2bf] transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed hover:text-foreground",
                size === "sm" ? "min-h-7 text-xs" : "min-h-[30px] text-[13px]",
                option.tone === "allow"
                  ? "peer-checked:bg-[#1f4a44] peer-checked:text-[#9ff0e3]"
                  : option.tone === "block"
                    ? "peer-checked:bg-[#4a2326] peer-checked:text-[#ffb3b3]"
                    : "peer-checked:bg-[#3d4451] peer-checked:text-white",
              )}
            >
              {option.label}
            </label>
          </span>
        )
      })}
    </fieldset>
  )
}

export { SegmentedControl }
