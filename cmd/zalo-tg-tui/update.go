package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	"github.com/charmbracelet/x/ansi"
)

func (m model) Init() tea.Cmd {
	return tea.Batch(readNext(m.scanner), tick(), m.spinner.Tick, animTick())
}

func readNext(scanner *bufio.Scanner) tea.Cmd {
	return func() tea.Msg {
		if scanner.Scan() {
			var env envelope
			if err := json.Unmarshal(scanner.Bytes(), &env); err != nil {
				return readErrMsg{err: err}
			}
			return envelopeMsg(env)
		}
		if err := scanner.Err(); err != nil {
			return readErrMsg{err: err}
		}
		return eofMsg{}
	}
}

func tick() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func animTick() tea.Cmd {
	return tea.Tick(time.Second/animFPS, func(t time.Time) tea.Msg { return animTickMsg{} })
}

func emit(msg tea.Msg) tea.Cmd {
	return func() tea.Msg { return msg }
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.layout()
		return m, nil

	case tea.KeyMsg:
		switch {
		case m.selection.has && key.Matches(msg, m.keys.Copy):
			return m, m.copySelection()
		case m.selection.has && key.Matches(msg, m.keys.Clear):
			m.selection = selectionState{}
			m.flash = ""
			m.layout()
			return m, nil
		case key.Matches(msg, m.keys.Quit):
			if m.selection.has {
				return m, m.copySelection()
			}
			signalParent()
			return m, tea.Quit
		case key.Matches(msg, m.keys.Select):
			m.selectMode = !m.selectMode
			if m.selectMode {
				m.frozenView = m.renderFrame()
				if m.mouse {
					return m, emit(tea.DisableMouse())
				}
				return m, nil
			}
			m.frozenView = ""
			m.layout()
			if m.mouse {
				return m, tea.Batch(emit(tea.EnableMouseCellMotion()), tick(), animTick(), m.spinner.Tick)
			}
			return m, tea.Batch(tick(), animTick(), m.spinner.Tick)
		case key.Matches(msg, m.keys.Docs):
			if m.selectMode {
				return m, nil
			}
			m.showDocs = !m.showDocs
			if !m.showDocs {
				m.focus = paneActivity
			} else {
				m.focus = paneDocs
			}
			m.layout()
			return m, nil
		case key.Matches(msg, m.keys.Help):
			if m.selectMode {
				return m, nil
			}
			m.help.ShowAll = !m.help.ShowAll
			m.layout()
			return m, nil
		case key.Matches(msg, m.keys.Focus):
			if m.selectMode {
				return m, nil
			}
			if m.showDocs && m.focus == paneActivity {
				m.focus = paneDocs
			} else {
				m.focus = paneActivity
			}
			return m, nil
		case key.Matches(msg, m.keys.Top):
			if m.selectMode {
				return m, nil
			}
			m.focusedViewport().GotoTop()
			return m, nil
		case key.Matches(msg, m.keys.Bottom):
			if m.selectMode {
				return m, nil
			}
			m.focusedViewport().GotoBottom()
			return m, nil
		case key.Matches(msg, m.keys.Up):
			if m.selectMode {
				return m, nil
			}
			m.focusedViewport().ScrollUp(1)
			return m, nil
		case key.Matches(msg, m.keys.Down):
			if m.selectMode {
				return m, nil
			}
			m.focusedViewport().ScrollDown(1)
			return m, nil
		case key.Matches(msg, m.keys.PageUp):
			if m.selectMode {
				return m, nil
			}
			m.focusedViewport().PageUp()
			return m, nil
		case key.Matches(msg, m.keys.PageDown):
			if m.selectMode {
				return m, nil
			}
			m.focusedViewport().PageDown()
			return m, nil
		}
		m.updateFocusedViewport(msg, &cmds)

	case tea.MouseMsg:
		if m.selectMode {
			return m, nil
		}
		switch msg.Type {
		case tea.MouseWheelUp:
			m.focusedViewport().ScrollUp(3)
			m.layout()
			return m, nil
		case tea.MouseWheelDown:
			m.focusedViewport().ScrollDown(3)
			m.layout()
			return m, nil
		}
		if handled, cmd := m.handleActivitySelection(msg); handled {
			return m, cmd
		}
		m.updateFocusedViewport(msg, &cmds)

	case envelopeMsg:
		env := envelope(msg)
		wasLive := m.activity.AtBottom() || m.activity.TotalLineCount() == 0

		prevEvents := m.state.Events
		m.state = env.State
		if len(m.state.Events) == 0 {
			m.state.Events = prevEvents
		}
		if env.Event != nil {
			m.eventCount++
		}
		if env.State.Phase != "" {
			m.phase = env.State.Phase
		}
		if !m.selectMode {
			m.layout()
			if wasLive {
				m.activity.GotoBottom()
			}
		}
		if (env.Type == "shutdown" || env.Type == "quit") && !m.quitting {
			m.quitting = true
			return m, tea.Quit
		}
		return m, readNext(m.scanner)

	case readErrMsg:
		m.err = msg.err
		return m, tea.Quit

	case eofMsg:
		return m, tea.Quit

	case tickMsg:
		if m.selectMode {
			return m, nil
		}
		return m, tick()

	case animTickMsg:
		if m.selectMode {
			return m, nil
		}
		m.frame++
		if m.toast != "" {
			m.toastFrame++
			if m.toastFrame >= m.toastTotal {
				m.toast = ""
				m.toastFrame = 0
			}
			m.layout()
		}
		if len(m.state.Events) == 0 || m.quitting {
			m.layout()
		}
		return m, animTick()

	case spinner.TickMsg:
		if m.selectMode {
			return m, nil
		}
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		if len(m.state.Events) == 0 {
			m.layout()
		}
		return m, cmd

	case clearFlashMsg:
		m.flash = ""
		return m, nil

	case clearClipboardMsg:
		m.clipboard = ""
		return m, nil

	case clipboardWriteMsg:
		if msg.method != "" && strings.HasPrefix(m.toast, "copied ") {
			m.toast += " to clipboard"
		}
		return m, nil
	}

	return m, tea.Batch(cmds...)
}

func (m *model) updateFocusedViewport(msg tea.Msg, cmds *[]tea.Cmd) {
	if m.showDocs && m.focus == paneDocs {
		var cmd tea.Cmd
		m.docs, cmd = m.docs.Update(msg)
		*cmds = append(*cmds, cmd)
		return
	}
	var cmd tea.Cmd
	m.activity, cmd = m.activity.Update(msg)
	*cmds = append(*cmds, cmd)
}

func (m *model) handleActivitySelection(msg tea.MouseMsg) (bool, tea.Cmd) {
	if !m.mouse || m.showDocs && min(150, max(56, m.width-2)) < 104 {
		return false, nil
	}

	switch {
	case msg.Button == tea.MouseButtonLeft && msg.Action == tea.MouseActionPress:
		row, ok := m.activityRowFromMouse(msg.Y, false)
		if !ok {
			return false, nil
		}
		m.focus = paneActivity
		m.selection = selectionState{active: true, has: true, anchor: row, cursor: row}
		m.layout()
		return true, nil

	case msg.Button == tea.MouseButtonLeft && msg.Action == tea.MouseActionMotion:
		if !m.selection.active {
			return false, nil
		}
		row, ok := m.activityRowFromMouse(msg.Y, true)
		if !ok {
			return true, nil
		}
		m.selection.cursor = row
		m.layout()
		return true, nil

	case msg.Action == tea.MouseActionRelease:
		if !m.selection.active {
			return false, nil
		}
		m.selection.active = false
		m.layout()
		return true, m.copySelection()

	case msg.Button == tea.MouseButtonRight && msg.Action == tea.MouseActionPress:
		if !m.selection.has {
			return false, nil
		}
		return true, m.copySelection()
	}

	return false, nil
}

func (m *model) activityRowFromMouse(y int, allowAutoscroll bool) (int, bool) {
	if len(m.rows) == 0 {
		return 0, false
	}
	top := activityViewportTop()
	bottom := top + m.activity.Height
	if y < top {
		if allowAutoscroll {
			m.activity.ScrollUp(1)
			return clamp(m.activity.YOffset, 0, len(m.rows)-1), true
		}
		return 0, false
	}
	if y >= bottom {
		if allowAutoscroll {
			m.activity.ScrollDown(1)
			return clamp(m.activity.YOffset+m.activity.Height-1, 0, len(m.rows)-1), true
		}
		return 0, false
	}
	return clamp(m.activity.YOffset+y-top, 0, len(m.rows)-1), true
}

func (m selectionState) bounds(maxRows int) (int, int, bool) {
	if !m.has || maxRows <= 0 {
		return 0, 0, false
	}
	start, end := m.anchor, m.cursor
	if start > end {
		start, end = end, start
	}
	return clamp(start, 0, maxRows-1), clamp(end, 0, maxRows-1), true
}

func (m model) rowSelected(index int) bool {
	start, end, ok := m.selection.bounds(len(m.rows))
	return ok && index >= start && index <= end
}

func (m model) selectedText() string {
	start, end, ok := m.selection.bounds(len(m.rows))
	if !ok {
		return ""
	}
	lines := make([]string, 0, end-start+1)
	for i := start; i <= end; i++ {
		if text := strings.TrimSpace(m.rows[i].plain); text != "" {
			lines = append(lines, text)
		}
	}
	return strings.Join(lines, "\n")
}

func (m *model) copySelection() tea.Cmd {
	text := m.selectedText()
	if strings.TrimSpace(text) == "" {
		m.flash = "nothing selected"
		return tea.Tick(1200*time.Millisecond, func(time.Time) tea.Msg { return clearFlashMsg{} })
	}
	m.selection = selectionState{}
	m.clipboard = ansi.SetSystemClipboard(text)
	lines := strings.Count(text, "\n") + 1
	m.toast = fmt.Sprintf("copied %d line%s", lines, plural(lines))
	m.toastFrame = 0
	m.toastTotal = 30
	m.layout()
	return tea.Batch(
		copyToSystemClipboard(text),
		tea.Tick(80*time.Millisecond, func(time.Time) tea.Msg { return clearClipboardMsg{} }),
	)
}

func copyToSystemClipboard(text string) tea.Cmd {
	return func() tea.Msg {
		for _, candidate := range [][]string{
			{"pbcopy"},
			{"wl-copy"},
			{"xclip", "-selection", "clipboard"},
		} {
			path, err := exec.LookPath(candidate[0])
			if err != nil {
				continue
			}
			cmd := exec.Command(path, candidate[1:]...)
			cmd.Stdin = strings.NewReader(text)
			if err := cmd.Run(); err == nil {
				return clipboardWriteMsg{method: candidate[0]}
			}
		}
		return clipboardWriteMsg{}
	}
}

func (m *model) focusedViewport() *viewport.Model {
	if m.showDocs && m.focus == paneDocs {
		return &m.docs
	}
	return &m.activity
}

func (m *model) layout() {
	if m.width <= 0 {
		m.width = 100
	}
	if m.height <= 0 {
		m.height = 30
	}

	contentWidth := min(150, max(56, m.width-2))
	footerHeight := 1
	if m.help.ShowAll {
		footerHeight = 3
	}
	topHeight := 1
	statusHeight := 1
	panelFrameHeight := 3
	paneHeight := max(3, m.height-topHeight-statusHeight-footerHeight-panelFrameHeight-1)

	docsWidth := 0
	mainWidth := contentWidth
	if m.showDocs && contentWidth >= 104 {
		docsWidth = clamp(contentWidth/3, 34, 52)
		mainWidth = contentWidth - docsWidth - 2
	}

	m.activity.Width = max(24, mainWidth-4)
	m.activity.Height = paneHeight
	m.rows = m.buildActivityRows(m.activity.Width)
	m.activity.SetContent(renderActivityRows(m.rows))
	if m.activity.PastBottom() {
		m.activity.GotoBottom()
	}
	if len(m.rows) > 0 && m.selection.has {
		m.selection.anchor = clamp(m.selection.anchor, 0, len(m.rows)-1)
		m.selection.cursor = clamp(m.selection.cursor, 0, len(m.rows)-1)
	}

	if docsWidth > 0 {
		m.docs.Width = max(24, docsWidth-4)
		m.docs.Height = paneHeight
		m.docs.SetContent(m.markdownContent(m.docs.Width))
		if m.docs.PastBottom() {
			m.docs.GotoBottom()
		}
	}

	m.help.Width = contentWidth
}
