import type { Linter } from "eslint";
import { guessBranch } from "./ci";
import {
  fetchFromOrigin,
  getDiffFileList,
  getDiffForFile,
  getRangesForDiff,
  getUntrackedFileList,
  hasCleanIndex,
} from "./git";
import type { Range } from "./Range";

/**
 * Exclude unchanged files from being processed
 *
 * Since we're excluding unchanged files in the post-processor, we can exclude
 * them from being processed in the first place, as a performance optimization.
 * This is increasingly useful the more files there are in the repository.
 */
const getPreProcessor =
  (untrackedFileList: string[], diffFileList: string[]) =>
  (text: string, filename: string) => {
    const shouldBeProcessed =
      process.env.VSCODE_CLI !== undefined ||
      diffFileList.includes(filename) ||
      untrackedFileList.includes(filename);

    return shouldBeProcessed ? [text] : [];
  };

const isLineWithinRange = (line: number) => (range: Range) =>
  range.isWithinRange(line);

/**
 * @internal
 */
const getUnstagedChangesError = (filename: string): [Linter.LintMessage] => {
  // When we only want to diff staged files, but the file is partially
  // staged, the ranges of the staged diff might not match the ranges of the
  // unstaged diff and could cause a conflict, so we return a fatal
  // error-message instead.

  const fatal = true;
  const message = `${filename} has unstaged changes. Please stage or remove the changes.`;
  const severity: Linter.Severity = 2;
  const fatalError: Linter.LintMessage = {
    fatal,
    message,
    severity,
    column: 0,
    line: 0,
    ruleId: null,
  };

  return [fatalError];
};

const getPostProcessor =
  (untrackedFileList: string[], staged = false) =>
  (
    messages: Linter.LintMessage[][],
    filename: string
  ): Linter.LintMessage[] => {
    if (messages.length === 0) {
      // No need to filter, just return
      return [];
    }

    if (untrackedFileList.includes(filename)) {
      // We don't need to filter the messages of untracked files because they
      // would all be kept anyway, so we return them as-is.
      return messages.flat();
    }

    if (staged && !hasCleanIndex(filename)) {
      return getUnstagedChangesError(filename);
    }

    const rangesForDiff = getRangesForDiff(getDiffForFile(filename, staged));

    return messages.flatMap((message) => {
      const filteredMessage = message.filter(({ fatal, line }) => {
        if (fatal === true) {
          return true;
        }

        const isLineWithinSomeRange = rangesForDiff.some(
          isLineWithinRange(line)
        );

        return isLineWithinSomeRange;
      });

      return filteredMessage;
    });
  };

type ProcessorType = "diff" | "staged" | "ci";

const getProcessors = (
  processorType: ProcessorType
): Required<Linter.Processor> => {
  const staged = processorType === "staged";
  if (processorType === "ci") {
    if (process.env.CI === undefined) {
      throw Error("Expected CI environment");
    }

    const branch = process.env.ESLINT_PLUGIN_DIFF_COMMIT ?? guessBranch();
    if (branch !== undefined) {
      fetchFromOrigin(branch);
    }
  }
  const untrackedFileList = getUntrackedFileList(staged);
  const diffFileList = getDiffFileList(staged);

  return {
    preprocess: getPreProcessor(untrackedFileList, diffFileList),
    postprocess: getPostProcessor(untrackedFileList, staged),
    supportsAutofix: true,
  };
};

const ci = process.env.CI !== undefined ? getProcessors("ci") : {};
const diff = getProcessors("diff");
const staged = getProcessors("staged");

const diffConfig: Linter.BaseConfig = {
  plugins: ["diff"],
  overrides: [
    {
      files: ["*"],
      processor: "diff/diff",
    },
  ],
};

const ciConfig: Linter.BaseConfig =
  process.env.CI === undefined
    ? {}
    : {
        plugins: ["diff"],
        overrides: [
          {
            files: ["*"],
            processor: "diff/ci",
          },
        ],
      };

const stagedConfig: Linter.BaseConfig = {
  plugins: ["diff"],
  overrides: [
    {
      files: ["*"],
      processor: "diff/staged",
    },
  ],
};

export {
  ci,
  ciConfig,
  diff,
  diffConfig,
  staged,
  stagedConfig,
  getUnstagedChangesError,
};
