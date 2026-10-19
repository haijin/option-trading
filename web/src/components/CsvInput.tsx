import { type ChangeEvent, useId, useState } from 'react';
import { errorMessage } from '../api/client';
import { Field } from './Field';

/** A textarea that can also be filled from a chosen .csv file (the file is read in the browser, never uploaded as a file). */
export function CsvInput({
  label,
  value,
  onChange,
  placeholder,
  rows = 8,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const fileId = useId();
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      onChange(await file.text());
      setFileName(file.name);
      setFileError(null);
    } catch (error) {
      setFileError(`Could not read ${file.name}: ${errorMessage(error)}`);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <label htmlFor={fileId} className="muted" style={{ fontSize: 12 }}>
          Choose a .csv file
        </label>
        <input id={fileId} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
        {fileName ? <small>{fileName} loaded</small> : null}
      </div>
      {fileError ? (
        <span className="field-error" role="alert">
          {fileError}
        </span>
      ) : null}
      <Field label={label}>
        <textarea
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
      </Field>
    </div>
  );
}
