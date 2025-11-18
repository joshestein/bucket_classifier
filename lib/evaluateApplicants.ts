import { Record as AirtableRecord, Table as AirtableTable } from '@airtable/blocks/models';
import pRetry from 'p-retry';
import { Prompt } from './getChatCompletion';
import { getChatCompletion } from './getChatCompletion/openai';
import { Preset } from './preset';

type SetProgress = (updater: (prev: number) => number) => void;

/**
 * @returns array of promises, each expected to return an evaluation
 */
export const evaluateApplicants = (
  applicants: AirtableRecord[],
  selectedBuckets: AirtableRecord[],
  preset: Preset,
  setProgress: SetProgress,
): Promise<Record<string, unknown>>[] => {
  return applicants.map(async (applicant) => {
    const innerSetProgress: SetProgress = (updater) => {
      setProgress((progress) => progress + (1 / applicants.length) * updater(0));
    };
    const result: Record<string, unknown> = await evaluateApplicant(
      convertToPlainRecord(applicant, preset),
      extractBucketContext(selectedBuckets),
      preset,
      innerSetProgress,
    );
    result[preset.evaluationApplicantField] = [{ id: applicant.id }];
    return result;
  });
};

const convertToPlainRecord = (applicant: AirtableRecord, preset: Preset): Record<string, string> => {
  const record = {};

  preset.applicantFields.forEach((field) => {
    const questionName =
      field.questionName ?? ((applicant as any).parentTable as AirtableTable).getFieldById(field.fieldId).name;
    record[questionName] = applicant.getCellValueAsString(field.fieldId);
    record['applicantId'] = applicant.id;
  });

  return record;
};

const extractBucketContext = (buckets: AirtableRecord[]): string => {
  return buckets
    .map((bucket) => {
      return `### ${bucket.getCellValueAsString('Bucket')}\n\n${bucket.getCellValueAsString('Description')}`;
    })
    .join('\n\n');
};

// TODO: test if plain JSON is better
const stringifyApplicantForLLM = (applicant: Record<string, string>): string => {
  return Object.entries(applicant)
    .filter(([, value]) => value)
    .map(([key, value]) => `### ${key}\n\n${value}`)
    .join('\n\n');
};

const evaluateApplicant = async (
  applicant: Record<string, string>,
  bucketContext: string,
  preset: Preset,
  setProgress: SetProgress,
): Promise<Record<string, number | string>> => {
  const applicantString = stringifyApplicantForLLM(applicant);
  const { buckets, transcript } = await pRetry(async () => evaluateItem(applicantString, bucketContext), {
    onFailedAttempt: (error) =>
      console.error(
        `Failed processing record on attempt ${error.attemptNumber} for applicant ${applicant.applicantId}: `,
        error,
      ),
    retries: 3,
  });
  setProgress((prev) => prev + 1);

  const results: Record<string, number | string> = {
    [preset.bucketClassificationField]: buckets,
  };
  if (preset.evaluationLogsField) {
    results[preset.evaluationLogsField] = transcript;
  }
  return results;
};

// TODO: test if returning response in JSON is better
const extractRankedBuckets = (text: string, rankingKeyword = 'BUCKET_RANKINGS') => {
  const regex = new RegExp(`${rankingKeyword}\\s*\\n((?:.+:\\s*\\d+%\\s*\\n?)*)`, 'mi');
  const match = text.match(regex);

  if (match) {
    return match[1]?.trim() || '';
  }

  throw new Error(`Missing bucket ranking (${rankingKeyword})\n\nFull response:\n${text}`);
};

const evaluateItem = async (applicantString: string, bucketContext: string) => {
  const prompt: Prompt = [
    { role: 'user', content: applicantString },
    {
      role: 'system',
      content: `Classify this applicant into one or more of the following buckets:
      
${bucketContext}

---

You should ignore general statements or facts about the world, and focus on what the applicant themselves has achieved. You do not need to structure your assessment similar to the answers the user has given.

Rank the buckets by fit, with confidence scores (0-100%). Only include buckets where the confidence is at least 30%. If no buckets are a good fit, return an empty list.

Before stating your rating, first explain your reasoning thinking step by step. Then afterwards output your final answer in the following format:

BUCKET_RANKINGS
Bucket A: 90%
Bucket B: 75%
Bucket C: 40%

---

Note that your output length is limited to 1_000 tokens, so be concise in your reasoning.
`,
    },
  ];
  const completion = await getChatCompletion(prompt);
  const transcript = [...prompt, { role: 'assistant', content: completion }]
    .map((message) => `## ${message.role}\n\n${message.content}`)
    .join('\n\n');
  const buckets = extractRankedBuckets(completion);
  return { transcript, buckets };
};
