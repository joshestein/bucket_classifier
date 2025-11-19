import { globalConfig } from '@airtable/blocks';
import { Field, FieldType, type View } from '@airtable/blocks/models';
import {
  Button,
  CellRenderer,
  expandRecord,
  FieldPicker,
  FieldPickerSynced,
  FormField,
  Input,
  ProgressBar,
  TablePickerSynced,
  Text,
  useBase,
  useCursor,
  useLoadable,
  useRecordById,
  useWatchable,
  ViewPickerSynced,
} from '@airtable/blocks/ui';
import pRetry from 'p-retry';
import React, { useEffect, useState } from 'react';
import { evaluateApplicants } from '../lib/evaluateApplicants';
import { Preset, upsertPreset, useSelectedPreset } from '../lib/preset';

// TODO: make fields configurable
export const BUCKET_FIELD_NAME = 'Bucket';
export const DESCRIPTION_FIELD_NAME = 'Description';

const renderPreviewText = (numberOfItems: number) => {
  const timeEstimateMins = ((numberOfItems * 0.9) / 60).toFixed(1); // speed roughly for gpt-4-1106-preview, at 30 request concurrency
  const costEstimateGbp = (numberOfItems * 0.011).toFixed(2); // pricing roughly for gpt-4-1106-preview
  return `Found ${numberOfItems} records to process. Estimated time: ${timeEstimateMins} min. Estimated cost: £${costEstimateGbp}. To cancel, please close the entire browser tab.`;
};

export const MainPage = () => {
  const preset = useSelectedPreset();

  const base = useBase();
  const applicantTable = base.getTableByIdIfExists(preset.applicantTableId);
  const bucketTable = base.getTableByIdIfExists(preset.bucketTableId);
  const evaluationTable = base.getTableByIdIfExists(preset.evaluationTableId);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0); // between 0.0 and 1.0
  const [result, setResult] = useState<string>(null);
  const run = async () => {
    setRunning(true);
    setProgress(0);
    setResult(null);
    try {
      if (!applicantTable) throw new Error('Could not access applicant table');
      if (!bucketTable) throw new Error('Could not access bucket table');
      if (!evaluationTable) throw new Error('Could not access evaluation table');
      if (!preset.applicantFields.length) throw new Error('No input fields selected');
      if (!preset.selectedBucketIds.length) throw new Error('No buckets selected');
      if (!preset.bucketClassificationField.length)
        throw new Error('No output field selected for bucket classification');

      setResult('Getting applicant records...');
      const applicantView = applicantTable.getViewByIdIfExists(preset.applicantViewId);
      if (!applicantView) throw new Error('Could not access applicant table view');
      const applicantRecords = await applicantView.selectRecordsAsync({
        fields: preset.applicantFields.map((f) => f.fieldId),
      });
      setResult(renderPreviewText(applicantRecords.records.length));

      const bucketView = bucketTable.getViewByIdIfExists(preset.bucketViewId);
      if (!bucketView) throw new Error('Could not access bucket table view');
      const allBuckets = await bucketView.selectRecordsAsync({ fields: [BUCKET_FIELD_NAME, DESCRIPTION_FIELD_NAME] });
      const selectedBuckets = allBuckets.records.filter((record) => preset.selectedBucketIds.includes(record.id));

      const evaluationWritingPromises = await Promise.allSettled(
        evaluateApplicants(applicantRecords.records, selectedBuckets, preset, setProgress).map(
          async (evaluationPromise) => {
            const evaluation = await evaluationPromise;
            console.log(
              `Evaluated applicant ${evaluation[preset.evaluationApplicantField]?.[0]?.id}, uploading to Airtable...`,
            );
            // It would be more efficient to do this as a batch. However, this caused us far more trouble that it was worth with the Airtable API - hitting size limits etc.
            // Retrying helps handle other Airtable rate limits or intermittent faults
            return pRetry(() => evaluationTable.createRecordAsync(evaluation));
          },
        ),
      );
      const successes = evaluationWritingPromises.filter((p) => p.status === 'fulfilled');
      const failures = evaluationWritingPromises.filter((p) => p.status === 'rejected');
      failures.map((f) => console.error('Failed to evaluate applicant', f));
      setResult(
        `Successfully created ${successes.length} evaluation(s).${failures.length !== 0 ? ` Failed ${failures.length} times. See console logs for failure details.` : ''}`,
      );
    } catch (error) {
      const errorMessage = 'Error: ' + (error instanceof Error ? error.message : String(error));
      setResult(errorMessage);
      setRunning(false);
    }
    setRunning(false);
  };

  return (
    <div className="mb-24">
      <div className="flex flex-col gap-4">
        <div className="rounded-md border p-2">
          <FormField label="Applicant table">
            <TablePickerSynced
              globalConfigKey={['presets', preset.name, 'applicantTableId']}
              onChange={() => {
                globalConfig.setAsync(['presets', preset.name, 'applicantViewId'], '');
                globalConfig.setAsync(['presets', preset.name, 'applicantFields'], []);
              }}
            />
          </FormField>
          {applicantTable && (
            <>
              <FormField label="Applicant view">
                <ViewPickerSynced
                  globalConfigKey={['presets', preset.name, 'applicantViewId']}
                  table={applicantTable}
                />
              </FormField>
              <FormField label="Answer (input) fields">
                <div className="flex flex-col gap-2">
                  {preset.applicantFields.map((_, index) => (
                    <ApplicantFieldEditor key={index} preset={preset} index={index} />
                  ))}
                  <ApplicantFieldEditor
                    key={preset.applicantFields.length}
                    preset={preset}
                    index={preset.applicantFields.length}
                  />
                </div>
              </FormField>
            </>
          )}
        </div>

        <div className="rounded-md border p-2">
          <FormField label="Evaluation table">
            <TablePickerSynced
              globalConfigKey={['presets', preset.name, 'evaluationTableId']}
              onChange={() => {
                globalConfig.setAsync(['presets', preset.name, 'evaluationLogsField'], undefined);
              }}
            />
          </FormField>
          {evaluationTable && (
            <>
              <FormField label="Applicant field">
                <FieldPickerSynced
                  allowedTypes={[FieldType.MULTIPLE_RECORD_LINKS]}
                  globalConfigKey={['presets', preset.name, 'evaluationApplicantField']}
                  table={evaluationTable}
                />
              </FormField>
              <FormField label="Bucket classification field">
                <FieldPickerSynced
                  allowedTypes={[FieldType.MULTILINE_TEXT]}
                  globalConfigKey={['presets', preset.name, 'bucketClassificationField']}
                  table={evaluationTable}
                />
              </FormField>
              <FormField label="(optional) Logs field">
                <FieldPickerSynced
                  allowedTypes={[FieldType.SINGLE_LINE_TEXT, FieldType.MULTILINE_TEXT, FieldType.RICH_TEXT]}
                  globalConfigKey={['presets', preset.name, 'evaluationLogsField']}
                  table={evaluationTable}
                  shouldAllowPickingNone={true}
                />
              </FormField>
            </>
          )}
        </div>

        <div className="rounded-md border p-2">
          <FormField label="Bucket table">
            <TablePickerSynced
              globalConfigKey={['presets', preset.name, 'bucketTableId']}
              onChange={() => {
                globalConfig.setAsync(['presets', preset.name, 'bucketViewId'], '');
              }}
            />
          </FormField>
          {bucketTable && (
            <>
              <FormField label="Bucket view">
                <ViewPickerSynced globalConfigKey={['presets', preset.name, 'bucketViewId']} table={bucketTable} />
              </FormField>
              <SelectedBuckets preset={preset} />
            </>
          )}
        </div>
      </div>

      <Button type="button" variant="primary" icon="play" onClick={run} disabled={running} className="mt-2">
        Run
      </Button>
      {running && <ProgressBar className="my-2" progress={progress} />}
      {result && <Text className="my-2">{result}</Text>}
    </div>
  );
};

interface FieldEditorProps {
  preset: Preset;
  index: number;
}

const ApplicantFieldEditor: React.FC<FieldEditorProps> = ({ preset, index }) => {
  const applicantField = preset.applicantFields[index] ?? { fieldId: '' };

  const base = useBase();
  const applicantTable = base.getTableByIdIfExists(preset.applicantTableId);

  const [field, setField] = useState<Field>(applicantTable.getFieldByIdIfExists(applicantField.fieldId));
  const [questionName, setQuestionName] = useState<string>(applicantField.questionName ?? '');

  const saveField = (applicantField: Preset['applicantFields'][number]) => {
    // delete
    if (!applicantField.fieldId) {
      upsertPreset({ ...preset, applicantFields: preset.applicantFields.filter((_, i) => i !== index) });
      // create
    } else if (index >= preset.applicantFields.length) {
      upsertPreset({ ...preset, applicantFields: [...preset.applicantFields, applicantField] });
    } else {
      upsertPreset({
        ...preset,
        applicantFields: preset.applicantFields.map((original, i) => (i === index ? applicantField : original)),
      });
    }
  };

  return (
    <div className="grid grid-cols-2 gap-2 rounded border bg-white p-2 shadow">
      <FormField label="Source field" className="mb-0">
        <FieldPicker
          table={applicantTable}
          shouldAllowPickingNone={true}
          onChange={(field) => {
            setField(field);
            saveField({ ...applicantField, fieldId: field?.id });
          }}
          field={field}
        />
      </FormField>
      <FormField label="(optional) Question name" className="mb-0">
        <Input
          value={questionName}
          onChange={(event) => {
            setQuestionName(event.target.value);
            saveField({ ...applicantField, questionName: event.target.value || undefined });
          }}
        />
      </FormField>
    </div>
  );
};

interface SelectedBucketsProps {
  preset: Preset;
}

const SelectedBuckets: React.FC<SelectedBucketsProps> = ({ preset }) => {
  const base = useBase();
  const cursor = useCursor();
  useLoadable(cursor);
  // Re-render whenever the selected records change.
  useWatchable(cursor, ['selectedRecordIds']);

  useEffect(() => {
    const currentIds = preset.selectedBucketIds || [];
    const newIds = cursor.selectedRecordIds || [];

    if (currentIds.length !== newIds.length || !newIds.every((id) => currentIds.includes(id))) {
      globalConfig.setAsync(['presets', preset.name, 'selectedBucketIds'], newIds);
    }
  }, [preset.name, preset.selectedBucketIds, cursor.selectedRecordIds]);

  const bucketTable = base.getTableById(preset.bucketTableId);
  const bucketView = bucketTable.getViewByIdIfExists(preset.bucketViewId);

  const bucket = bucketTable.getFieldByNameIfExists(BUCKET_FIELD_NAME);
  const description = bucketTable.getFieldByNameIfExists(DESCRIPTION_FIELD_NAME);

  if (cursor.activeTableId !== bucketTable.id) {
    return <Text className="font-bold">Switch to the “{bucketTable.name}” table to select buckets.</Text>;
  }

  if (cursor.selectedRecordIds.length === 0) {
    return <Text className="font-bold">No rows selected. Select one or more bucket records.</Text>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {cursor.selectedRecordIds.map((recordId) => (
        <SelectedBucketListItem
          key={recordId}
          view={bucketView}
          recordId={recordId}
          bucket={bucket}
          description={description}
        />
      ))}
    </ul>
  );
};

interface SelectedBucketListItemProps {
  view: View;
  recordId: string;
  bucket: Field;
  description: Field;
}

const SelectedBucketListItem: React.FC<SelectedBucketListItemProps> = ({ view, recordId, bucket, description }) => {
  const record = useRecordById(view, recordId, { fields: [bucket, description] });
  if (!record) return null;

  return (
    <li key={record.id}>
      <button className="w-full rounded-md border bg-white p-2 shadow" onClick={() => expandRecord(record)}>
        <div className="flex flex-col items-start gap-2">
          <Text className="text-sm font-medium">{record.name}</Text>
          <CellRenderer record={record} field={bucket} />
          {description && (
            <div className="whitespace-pre-line text-left text-sm">{record.getCellValueAsString(description.id)}</div>
          )}
        </div>
      </button>
    </li>
  );
};
