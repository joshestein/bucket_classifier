import { globalConfig } from '@airtable/blocks';
import { Field, FieldType } from '@airtable/blocks/models';
import {
  Button,
  FieldPicker,
  FieldPickerSynced,
  FormField,
  Input,
  ProgressBar,
  TablePickerSynced,
  Text,
  useBase,
  ViewPickerSynced,
} from '@airtable/blocks/ui';
import pRetry from 'p-retry';
import React, { useState } from 'react';
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
      if (!preset.bucketFirstChoiceField.length) throw new Error('No output field for bucket first choice');
      if (!preset.bucketFirstChoiceConfidenceField.length)
        throw new Error('No output field selected for bucket first choice confidence scores');

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

      const evaluationWritingPromises = await Promise.allSettled(
        evaluateApplicants(applicantRecords.records, allBuckets.records, preset, setProgress).map(
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
              <FormField label="First bucket field">
                <FieldPickerSynced
                  allowedTypes={[FieldType.MULTIPLE_RECORD_LINKS]}
                  globalConfigKey={['presets', preset.name, 'bucketFirstChoiceField']}
                  table={evaluationTable}
                />
              </FormField>
              <FormField label="First bucket confidence field">
                <FieldPickerSynced
                  allowedTypes={[FieldType.MULTILINE_TEXT, FieldType.SINGLE_LINE_TEXT]}
                  globalConfigKey={['presets', preset.name, 'bucketFirstChoiceConfidenceField']}
                  table={evaluationTable}
                />
              </FormField>
              <FormField label="Second bucket field">
                <FieldPickerSynced
                  allowedTypes={[FieldType.MULTIPLE_RECORD_LINKS]}
                  globalConfigKey={['presets', preset.name, 'bucketSecondChoiceField']}
                  table={evaluationTable}
                />
              </FormField>
              <FormField label="Second bucket confidence field">
                <FieldPickerSynced
                  allowedTypes={[FieldType.MULTILINE_TEXT, FieldType.SINGLE_LINE_TEXT]}
                  globalConfigKey={['presets', preset.name, 'bucketSecondChoiceConfidenceField']}
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
