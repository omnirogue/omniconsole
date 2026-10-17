import type { SessionActionPresetId } from './session-action-presets'

/**
 * The built-in instruction template per action preset, written for ANY kind of work
 * (research notes, video, audio, documents, code). A template never assumes a code
 * workspace; the workspace is a folder and produced files are handed on by path.
 */
const SHARED_FOOTER = `
Workspace: {{workspacePath}}
Write every file you produce (any type: md, pdf, mp4, wav, images) into {{outputDir}} and finish with a manifest at {{outputDir}}/manifest.md that lists each produced file with one line on what it is.`

const INPUT_BLOCK = `
Previous step said:
{{input}}

Files from the previous step:
{{inputFiles}}`

// Why no verdict envelope in these templates any more: the host appends ONE filled envelope to
// every verdict-emitting seat's brief (`buildSessionVerdictInstructions`, named for that seat, its
// attempt and the version it judges). A template that carried its own shape too would send the seat
// two payloads, and a report answering both ends in two markers — which is the forgery shape the
// parser refuses. The judging instruction stays here; the machine contract has one author.

export const DEFAULT_SESSION_ACTION_TEMPLATES: Record<SessionActionPresetId, string> = {
  research: `Research this objective and gather what a later step will need:
{{objective}}
${INPUT_BLOCK}
Collect sources, facts, examples and open questions. Save your findings as research.md with sources listed.${SHARED_FOOTER}`,
  analyze: `Analyze the material for this objective:
{{objective}}
${INPUT_BLOCK}
Explain what is there, what is missing, what is risky, and what to decide. Save analysis.md with a short recommendation at the top.${SHARED_FOOTER}`,
  plan: `Write a plan for this objective:
{{objective}}
${INPUT_BLOCK}
Produce plan.md: numbered steps, who or what does each one, the files each step produces, and how the result is checked.${SHARED_FOOTER}`,
  implement: `Produce the deliverable for this objective:
{{objective}}
${INPUT_BLOCK}
Do the work itself, not a description of it. Produce the actual files (documents, media, code or data) the objective asks for.${SHARED_FOOTER}`,
  improve: `Improve the previous result against this objective:
{{objective}}
${INPUT_BLOCK}
Keep what works, fix what does not, and save the improved version as new files (do not overwrite the inputs). Note every change you made in the manifest.${SHARED_FOOTER}`,
  synthesize: `Combine the inputs into one result for this objective:
{{objective}}
${INPUT_BLOCK}
Merge the parts into a single coherent deliverable, resolve contradictions, and say what you dropped and why.${SHARED_FOOTER}`,
  verify: `Verify the previous result against this objective:
{{objective}}
${INPUT_BLOCK}
Run the named check command or work through the checklist the workspace declares (README, CHECKLIST.md or a check script). Only run a test suite when the workspace declares one. Save verify.md with PASS or FAIL per item and the evidence.${SHARED_FOOTER}`,
  review: `Review the previous result against this objective:
{{objective}}
${INPUT_BLOCK}
List concrete findings ordered by severity, each with where it is and how to fix it, then a verdict: approve or revise. Save review.md.${SHARED_FOOTER}`,
  critique: `Critique the other results for this objective; you wrote none of them:
{{objective}}
${INPUT_BLOCK}
Name concrete defects, missing requirements and unverified claims, each with where it is and how to fix it. Do not edit the inputs. Save critique.md.${SHARED_FOOTER}`,
  compare: `Compare the results for this objective side by side:
{{objective}}
${INPUT_BLOCK}
Build one table of the differences that matter, say with evidence where each result is stronger or weaker, and name what a decision still needs. Do not edit the inputs. Save comparison.md.${SHARED_FOOTER}`,
  judge: `Judge the candidate results for this objective; you wrote none of them:
{{objective}}
${INPUT_BLOCK}
For every candidate, try to refute it: name concrete defects, missing requirements and unverified claims, and default to "does not pass" when unsure. Then rank the candidates best first. Do not edit them. Save judgement.md with one section per candidate: verdict, evidence. Use only the exact candidate ids you were given, every one of them, each once.${SHARED_FOOTER}`,
  summarize: `Summarize the results for this objective:
{{objective}}
${INPUT_BLOCK}
Keep every decision, number and open question; drop only repetition. Save summary.md with the short version first and the detail beneath it.${SHARED_FOOTER}`,
  test: `Exercise the previous result against this objective and report what held:
{{objective}}
${INPUT_BLOCK}
Run only the checks the objective or a file in the workspace declares (a README, a CHECKLIST or a check script). Save test-report.md with one line per check: its name, PASS or FAIL, and the exact output that proves it.${SHARED_FOOTER}`,
  repair: `Repair the documented blocking findings for this objective:
{{objective}}
${INPUT_BLOCK}
Fix only the findings named above, preserve every unaffected part, and save the repaired version as new files. List each finding you addressed and how you checked it.${SHARED_FOOTER}`
}
