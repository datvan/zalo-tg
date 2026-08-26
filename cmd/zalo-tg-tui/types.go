package main

import (
	"bufio"
	"time"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
)

type activityEvent struct {
	Time    string `json:"time"`
	Label   string `json:"label"`
	Message string `json:"message"`
	Tone    string `json:"tone"`
}

type serviceState struct {
	Bridge   string          `json:"bridge"`
	Telegram string          `json:"telegram"`
	Zalo     string          `json:"zalo"`
	Users    int             `json:"users"`
	Topics   int             `json:"topics"`
	Version  string          `json:"version"`
	Phase    string          `json:"phase"`
	Events   []activityEvent `json:"events"`
}

type envelope struct {
	Type   string         `json:"type"`
	State  serviceState   `json:"state"`
	Event  *activityEvent `json:"event,omitempty"`
	Reason string         `json:"reason,omitempty"`
}

type envelopeMsg envelope
type eofMsg struct{}
type readErrMsg struct{ err error }
type tickMsg time.Time
type animTickMsg struct{}
type clearFlashMsg struct{}
type clearClipboardMsg struct{}
type clipboardWriteMsg struct{ method string }

type pane string

const (
	paneActivity pane = "activity"
	paneDocs     pane = "docs"
)

const animFPS = 12

type model struct {
	scanner *bufio.Scanner
	state   serviceState
	width   int
	height  int
	frame   int

	activity viewport.Model
	docs     viewport.Model
	help     help.Model
	spinner  spinner.Model
	progress progress.Model
	keys     keyMap

	focus       pane
	showDocs    bool
	selectMode  bool
	mouse       bool
	selection   selectionState
	frozenView  string
	clipboard   string
	flash       string
	quitting    bool
	err         error
	rows        []activityRow
	markdownFor map[int]string

	eventCount   int
	phase        string

	toast      string
	toastFrame int
	toastTotal int
}

type activityRow struct {
	rendered string
	plain    string
}

type selectionState struct {
	active bool
	has    bool
	anchor int
	cursor int
}
