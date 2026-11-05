"use client"

import { useActionState, useState } from "react"

import {
  FormFooter,
  FormSection,
  MoreOptions,
  NameFields,
  ServerFormFrame,
  SwitchGroup,
} from "@/components/server-form-parts"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { SwitchRow } from "@/components/ui/switch"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  createStorageRootAction,
  updateStorageRootAction,
} from "@/lib/actions/storage"

type FolderMode = "encrypted" | "plain"

const MODES: ReadonlyArray<{ value: FolderMode; label: string }> = [
  { value: "encrypted", label: "Encrypted" },
  { value: "plain", label: "Plain" },
]

export type StorageFolderFormValues = {
  id?: string
  name: string
  slug?: string
  description: string
  path: string
  writeAs: string
  umask: string
  readOnly: boolean
}

export const EMPTY_STORAGE_FOLDER: StorageFolderFormValues = {
  name: "",
  description: "",
  path: "",
  writeAs: "",
  umask: "002",
  readOnly: false,
}

/**
 * Add or edit a storage folder on an SSH server: the folder's path, whose
 * files they should be, the umask for what PCP makes, and read-only.
 * Adding, it sits on the SSH server's page (`hostId`); editing, under the
 * folder's own Advanced.
 */
export function StorageFolderForm({
  initial,
  hostId,
  login,
}: {
  initial: StorageFolderFormValues
  /** Adding: the SSH server the folder is on. */
  hostId?: string
  /** The SSH server's login, which SFTP writes as. */
  login: string
}) {
  const editing = Boolean(initial.id)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    editing
      ? updateStorageRootAction
      : createStorageRootAction.bind(null, hostId ?? ""),
    { status: "idle" },
  )
  const prefix = editing ? `storage-${initial.id}` : "storage-new"

  const [name, setName] = useState(initial.name)
  const [slug, setSlug] = useState(initial.slug ?? "")
  const [description, setDescription] = useState(initial.description)
  const [path, setPath] = useState(initial.path)
  const [writeAs, setWriteAs] = useState(initial.writeAs)
  const [umask, setUmask] = useState(initial.umask)
  const [readOnly, setReadOnly] = useState(initial.readOnly)
  // Adding only: encrypted unless you choose plain. A saved folder changes
  // its mode by converting it, on its page.
  const [mode, setMode] = useState<FolderMode>("encrypted")
  const differs = writeAs.trim() !== "" && writeAs.trim() !== login

  const ownership = (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
        <Field
          label="Files are whose"
          htmlFor={`${prefix}-write-as`}
          hint={
            differs ? (
              <span className="text-warning">
                PCP signs in as {login}, so what it saves is {login}&apos;s, not{" "}
                {writeAs.trim()}&apos;s. Sign PCP in as {writeAs.trim()} on the
                SSH server, or give {login} the folder&apos;s group (with the
                setgid bit on the folder, new files take its group).
              </span>
            ) : (
              `Empty is ${login || "the SSH login"}, the login PCP signs in as.`
            )
          }
        >
          <Input
            id={`${prefix}-write-as`}
            name="writeAs"
            value={writeAs}
            onChange={(event) => setWriteAs(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={login}
            className="font-mono"
          />
        </Field>
        <Field
          label="Umask"
          htmlFor={`${prefix}-umask`}
          hint="002: the group can change them too."
        >
          <Input
            id={`${prefix}-umask`}
            name="umask"
            value={umask}
            onChange={(event) => setUmask(event.target.value)}
            pattern="0?[0-7]{1,3}"
            inputMode="numeric"
            placeholder="002"
            className="font-mono"
          />
        </Field>
      </div>
    </>
  )

  const readOnlySwitch = (
    <SwitchGroup>
      <SwitchRow
        id={`${prefix}-read-only`}
        name="readOnly"
        label="Read-only"
        description="Only listing, finding and getting files are offered: nothing an assistant does here can save, move or delete one."
        checked={readOnly}
        onChange={(event) => setReadOnly(event.target.checked)}
      />
    </SwitchGroup>
  )

  return (
    <ServerFormFrame editing={editing} action={action}>
      {editing ? <input type="hidden" name="id" value={initial.id} /> : null}
      <FormSection>
        <NameFields
          prefix={prefix}
          editing={editing}
          name={name}
          onNameChange={setName}
          slug={slug}
          onSlugChange={setSlug}
          description={description}
          onDescriptionChange={setDescription}
          namePlaceholder="Scans"
          descriptionPlaceholder="The scanner drops PDFs here; sort them into the year's folder."
          descriptionHint="What the folder holds and what an assistant may do there, in a sentence. An assistant reads this to choose a folder."
          slugHint="How an assistant refers to this folder in tool calls (folder/tool). Lowercase letters, digits and dashes."
        />
      </FormSection>
      <FormSection>
        <Field
          label="Folder"
          htmlFor={`${prefix}-path`}
          hint="Its full path on the server. Nothing outside it is reached: PCP checks every path's real place, so a link out is not followed."
        >
          <Input
            id={`${prefix}-path`}
            name="path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            required
            spellCheck={false}
            autoComplete="off"
            placeholder="/srv/samba/scans"
            className="font-mono"
          />
        </Field>
        {editing ? null : (
          <div className="flex flex-col gap-1.5" data-testid="storage-mode">
            <span className="text-sm leading-none font-medium">
              Files are kept
            </span>
            <SegmentedControl<FolderMode>
              name="mode"
              legend="Files are kept"
              options={MODES}
              value={mode}
              onValueChange={setMode}
              className="self-start"
            />
            <p className="text-xs text-muted-foreground">
              {mode === "encrypted"
                ? "Encrypted: the SSH server holds only unreadable objects, under .pcp-store in the folder, and their names stay in PCP. Files already in the folder are not shown; you can encrypt them later on the folder's page."
                : "Plain: the files as they are, readable by other apps on the server, such as Samba or Finder, and the files already there are shown. You can encrypt the folder later on its page."}
            </p>
          </div>
        )}
        {readOnlySwitch}
      </FormSection>
      {editing ? (
        <FormSection>{ownership}</FormSection>
      ) : (
        <MoreOptions
          description="Whose files they are, and the umask (002 unless you change it)."
          defaultOpen={false}
        >
          {ownership}
        </MoreOptions>
      )}
      <FormFooter
        editing={editing}
        state={state}
        submitLabel="Add folder"
        pendingText={editing ? "Saving…" : "Adding…"}
      />
    </ServerFormFrame>
  )
}
