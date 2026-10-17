import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

type FieldProps = {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function WorkflowTextField({
  label,
  value,
  onChange,
  disabled,
  multiline,
  inputType,
  prose,
  maxLength
}: FieldProps & {
  multiline?: boolean
  inputType?: 'text' | 'datetime-local'
  prose?: boolean
  maxLength?: number
}) {
  const id = useId()
  const props = {
    id,
    value,
    disabled,
    maxLength,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value)
  }
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <Textarea
          {...props}
          className={prose ? 'min-h-24 text-sm' : 'min-h-24 font-mono text-xs'}
        />
      ) : (
        <Input {...props} type={inputType} />
      )}
    </div>
  )
}

export function WorkflowSelect({
  label,
  value,
  onChange,
  disabled,
  options
}: FieldProps & {
  options: { value: string; label: string }[]
}) {
  const id = useId()
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function WorkflowError({ message }: { message: string | null | undefined }) {
  return message ? (
    <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
      {message}
    </p>
  ) : null
}

export function WorkflowValue({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-words font-mono text-xs">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </dd>
    </div>
  )
}
