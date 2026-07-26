//go:build !windows

package main

type progressReporter struct{}

func newProgressReporter() *progressReporter {
	return &progressReporter{}
}

func (p *progressReporter) Update(progressState) {}

func (p *progressReporter) Fail(title string, detail string) {
	p.Update(progressState{Title: title, Detail: detail, Percent: 100, Error: true})
}

func (p *progressReporter) Close() {}
