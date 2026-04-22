import type { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

class CustomReporter implements Reporter {
    github: boolean;
    testsExecuted: TestModel[] = [];
    testsRan: string[] = [];
    failedTests: FailedTestModel[] = [];

    constructor(options: { github?: boolean } = {}) {
        this.github = options?.github;
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
        }

        this.updateTest(test.id, testExecuted);

        console.log(`[${testNumber}] → ${test.parent.title} › ${test.title}`);
    }

    async onTestEnd(test: TestCase, result: TestResult) {
        // ✓
        // ✘
        // → 
        // ➤
        const retryCount = result.retry ? result.retry + 1 : 1;

        let testExecuted = this.getTestById(test.id);

        this.updateTestExecutionWithResult(testExecuted, test, result);

        let testNumber = testExecuted.runs[testExecuted.runs.length - 1].index;
        let retryNumber = testExecuted.runs.length;

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
                    let title = `[${failedTest.index}-${failedTest.run}] ✘ ${failedTest.parentTitle} › ${failedTest.title} (${this.formatDuration(failedTest.result.duration)})`
                    console.log(`::group::${title}`);
                    console.log(failedTest.result?.error?.stack);
                    console.log('::endgroup::');
                });
            }
        }
    }

    /**
     * Returns annotation string with title and list of failed tests
     * @param passed amount of passed tests
     * @param failed amount of failed tests
     * @returns Github annotation string
     */
    private getAnnotationString(passed: number, failed: number): string {
        let failedTestTitles: string = '';
        let encodedNewLine = '%0A';

        this.failedTests.forEach(failedTest => {
            failedTestTitles += '🔴 ' + failedTest.parentTitle + ' › ' + failedTest.title + ` (${this.formatDuration(failedTest.result.duration)})` + encodedNewLine;
        })

        return `::notice title=🎭 Playwright Tests Summary::passed: ${passed}${encodedNewLine}failed: ${failed}${encodedNewLine}${failedTestTitles.toString()}`;
    }

    /**
     * Updates testsExecuted with an updated prop of test
     * @param testId id of test
     * @param test updated test object
     */
    private updateTest(testId: string, test: TestModel) {
        let indexOfTest = this.testsExecuted.findIndex((t) => t.id === testId);

        if (indexOfTest !== -1) {
            // this.testsExecuted.splice(indexOfTest, 1, test)
            this.testsExecuted[indexOfTest] = test;
        } else {
            this.testsExecuted.push(test);
        }
    }

    /**
     * Returns test from testsExecuted filtered by id
     * @param testId id of test
     * @returns test object
     */
    private getTestById(testId: string): TestModel {
        return this.testsExecuted.find((test) => test.id === testId);
    }

    /**
     * Returns formatted time
     * @param duration time in milliseconds
     * @returns string formatted in 1h2m3s
     */
    private formatDuration(duration: number) {
        let time = new Date(duration);
        let hours = time.getUTCHours();
        let minutes = time.getUTCMinutes();
        let seconds = time.getUTCSeconds();
        // let milliseconds = time.getUTCMilliseconds();

        let out = '';

        if (hours) {
            out += hours + "h";
        }

        if (minutes) {
            out += minutes + "m";
        }


        out += seconds + "s"


        return out;
    }

    /**
     * Updates testsExecuted with result of test
     * @param testExecuted updated test execution object
     * @param test current test
     * @param result current test result
     */
    private updateTestExecutionWithResult(testExecuted: TestModel, test: TestCase, result: TestResult) {
        let run = testExecuted?.runs.find((r) => r.id === test.id);

        let runWithResult: RunModel = {
            ...run,
            result: result
        };

        let runs = testExecuted?.runs.filter((r) => r.id !== test.id);

        let updatedTest = {
            id: testExecuted?.id,
            title: testExecuted?.title,
            runs: [
                ...runs,
                runWithResult
            ]
        };

        this.updateTest(testExecuted.id, updatedTest);
    }
}

type TestModel = {
    id: string,
    title: string,
    runs: RunModel[]
}

type RunModel = {
    index: string,
    id: string,
    result?: TestResult
}

type FailedTestModel = {
    id: string,
    title: string,
    parentTitle?: string,
    index: string,
    run: string,
    result: TestResult
}

export default CustomReporter;