import fs from 'fs';
import path from 'path';
import type { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

// Strips ANSI escape codes (colors, formatting) from error messages
function stripAnsi(str: string): string {
    return str.replace(/\[[0-9;]*m/g, '');
}

type TestRecord = {
    id: string;
    title: string;
    suite: string;
    project: string;
    status: string;
    duration: string;
    retries: number;
    error: string | null;
}

type TestModel = {
    id: string;
    title: string;
    runs: RunModel[];
}

type RunModel = {
    index: string;
    id: string;
    result?: TestResult;
}

type FailedTestModel = {
    id: string;
    title: string;
    parentTitle?: string;
    index: string;
    run: string;
    result: TestResult;
}

class DashboardReporter implements Reporter {
    github: boolean;
    writeJson: boolean;
    testsExecuted: TestModel[] = [];
    testsRan: string[] = [];
    failedTests: FailedTestModel[] = [];
    testRecords: TestRecord[] = [];

    constructor(options: { github?: boolean; writeJson?: boolean } = {}) {
        this.github = options?.github ?? false;
        this.writeJson = options?.writeJson ?? false;
    }

    async onBegin(config: FullConfig, suite: Suite) {
        console.log(`running ${suite.allTests().length} tests using ${config.workers} workers`);
    }

    async onTestBegin(test: TestCase) {
        let testExecution = this.getTestById(test.id);
        this.testsRan.push(test.title);
        let testNumber = this.testsRan.length - 1;

        let testExecuted: TestModel = {
            id: test.id,
            title: test.title,
            runs: [
                ...(testExecution?.runs || []),
                {
                    index: testNumber.toString(),
                    id: test.id
                }
            ]
        };

        this.updateTest(test.id, testExecuted);

        console.log(`[${testNumber}] → ${test.parent.title} › ${test.title}`);
    }

    async onTestEnd(test: TestCase, result: TestResult) {
        const retryCount = result.retry ? result.retry + 1 : 1;

        let testExecuted = this.getTestById(test.id);
        this.updateTestExecutionWithResult(testExecuted, test, result);

        let testNumber = testExecuted.runs[testExecuted.runs.length - 1].index;

        let out = `[${testNumber}-${retryCount}]`;

        if (result.status === 'failed') {
            out += ` ✘ ${test.parent.title} › ${test.title} (${this.formatDuration(result.duration)})`;

            this.failedTests = this.failedTests.filter((t) => t.id !== test.id);
            this.failedTests.push({
                id: test.id,
                title: test.title,
                parentTitle: test.parent?.title,
                index: testNumber,
                run: retryCount.toString(),
                result: result
            });

            if (this.github) {
                console.log('::group::' + out);
                console.log(result.error?.stack);
                console.log('::endgroup::');
            } else {
                console.log(out);
            }
        } else {
            this.failedTests = this.failedTests.filter((t) => t.id !== test.id);
            out += ` ✓ ${test.parent.title} › ${test.title} (${this.formatDuration(result.duration)})`;
            console.log(out);
        }

        // Accumulate for JSON output — deduplicated in onEnd to keep only the final retry attempt
        this.testRecords.push({
            id: test.id,
            title: test.title,
            suite: test.parent.title,
            // project name is the Playwright config project (e.g. chromium/firefox/webkit)
            project: test.titlePath()[0] ?? '',
            status: this.deriveStatus(test, result),
            duration: this.formatDuration(result.duration),
            retries: result.retry,
            error: result.error?.message ? stripAnsi(result.error.message) : null,
        });
    }

    async onEnd(result: FullResult) {
        const passed = this.testsExecuted.length - this.failedTests.length;
        const failed = this.failedTests.length;

        console.log(`run finished: ${result.status}`);
        console.log(`passed: ${passed}`);
        console.log(`failed: ${failed}`);

        if (this.github) {
            console.log(this.getAnnotationString(passed, failed));

            if (failed > 0) {
                console.log('Failed tests');
                this.failedTests.forEach(failedTest => {
                    let title = `[${failedTest.index}-${failedTest.run}] ✘ ${failedTest.parentTitle} › ${failedTest.title} (${this.formatDuration(failedTest.result.duration)})`;
                    console.log(`::group::${title}`);
                    console.log(failedTest.result?.error?.stack);
                    console.log('::endgroup::');
                });
            }
        }

        const shouldWrite = !!process.env.CI || this.writeJson;
        if (!shouldWrite) return;

        // Keep only the last attempt per test (retries produce multiple onTestEnd calls per test id)
        const seen = new Set<string>();
        const dedupedTests = [...this.testRecords].reverse().filter(r => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
        }).reverse();

        const summary = {
            passed:  dedupedTests.filter(t => t.status === 'passed').length,
            failed:  dedupedTests.filter(t => t.status === 'failed' || t.status === 'timedOut').length,
            skipped: dedupedTests.filter(t => t.status === 'skipped').length,
            fixme:   dedupedTests.filter(t => t.status === 'fixme').length,
        };

        const runId        = process.env.GITHUB_RUN_ID   ?? `local-${Date.now()}`;
        const workflowName = process.env.GITHUB_WORKFLOW ?? 'local';

        const payload = {
            runId,
            workflowName,
            timestamp: new Date().toISOString(),
            // Note: FullResult.status uses 'timedout' (all lowercase), unlike TestResult.status ('timedOut')
            status: result.status,
            summary,
            tests: dedupedTests,
        };

        const dir = path.join(__dirname, '..', 'docs', 'data', 'runs');
        fs.mkdirSync(dir, { recursive: true });
        const filename = process.env.GITHUB_RUN_ID
            ? `${process.env.GITHUB_RUN_ID}.json`
            : `local-${Date.now()}.json`;
        fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload, null, 2));
    }

    private deriveStatus(test: TestCase, result: TestResult): string {
        // test.annotations is populated at definition time for test.fixme() and test.skip()
        if (test.annotations.some(a => a.type === 'fixme')) return 'fixme';
        return result.status;
    }

    private getAnnotationString(passed: number, failed: number): string {
        let failedTestTitles = '';
        const encodedNewLine = '%0A';

        this.failedTests.forEach(failedTest => {
            failedTestTitles += '🔴 ' + failedTest.parentTitle + ' › ' + failedTest.title +
                ` (${this.formatDuration(failedTest.result.duration)})` + encodedNewLine;
        });

        return `::notice title=🎭 Playwright Tests Summary::passed: ${passed}${encodedNewLine}failed: ${failed}${encodedNewLine}${failedTestTitles}`;
    }

    private updateTest(testId: string, test: TestModel) {
        const indexOfTest = this.testsExecuted.findIndex((t) => t.id === testId);
        if (indexOfTest !== -1) {
            this.testsExecuted[indexOfTest] = test;
        } else {
            this.testsExecuted.push(test);
        }
    }

    private getTestById(testId: string): TestModel {
        return this.testsExecuted.find((test) => test.id === testId);
    }

    private formatDuration(duration: number) {
        const time = new Date(duration);
        const hours = time.getUTCHours();
        const minutes = time.getUTCMinutes();
        const seconds = time.getUTCSeconds();

        let out = '';
        if (hours) out += hours + 'h';
        if (minutes) out += minutes + 'm';
        out += seconds + 's';
        return out;
    }

    private updateTestExecutionWithResult(testExecuted: TestModel, test: TestCase, result: TestResult) {
        const run = testExecuted?.runs.find((r) => r.id === test.id);

        const runWithResult: RunModel = { ...run, result };
        const runs = testExecuted?.runs.filter((r) => r.id !== test.id);

        this.updateTest(testExecuted.id, {
            id: testExecuted?.id,
            title: testExecuted?.title,
            runs: [...runs, runWithResult],
        });
    }
}

export default DashboardReporter;
