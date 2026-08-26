package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

func main() {
	reader, readFromStdin, err := eventReader()
	if err != nil {
		fmt.Fprintln(os.Stderr, "zalo-tg-tui:", err)
		os.Exit(1)
	}

	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	keys := newKeyMap()
	h := help.New()
	h.ShowAll = false
	h.Styles.ShortKey = h.Styles.ShortKey.Foreground(ui.palette.cyan).Bold(true)
	h.Styles.ShortDesc = h.Styles.ShortDesc.Foreground(ui.palette.muted)
	h.Styles.FullKey = h.Styles.FullKey.Foreground(ui.palette.cyan).Bold(true)
	h.Styles.FullDesc = h.Styles.FullDesc.Foreground(ui.palette.ink)

	activity := viewport.New(0, 0)
	activity.MouseWheelEnabled = true
	activity.MouseWheelDelta = 2
	activity.KeyMap = viewport.DefaultKeyMap()

	docs := viewport.New(0, 0)
	docs.MouseWheelEnabled = true
	docs.MouseWheelDelta = 2

	spin := spinner.New(
		spinner.WithSpinner(spinner.MiniDot),
		spinner.WithStyle(lipgloss.NewStyle().Foreground(ui.palette.cyan)),
	)
	bar := progress.New(
		progress.WithoutPercentage(),
		progress.WithSolidFill(string(ui.palette.cyan)),
		progress.WithFillCharacters('━', '─'),
		progress.WithWidth(12),
	)

	m := model{
		scanner: scanner,
		state: serviceState{
			Bridge:   "starting",
			Telegram: "waiting",
			Zalo:     "waiting",
			Version:  "1.0.0",
			Phase:    "STARTUP",
		},
		activity:    activity,
		docs:        docs,
		help:        h,
		spinner:     spin,
		progress:    bar,
		keys:        keys,
		focus:         paneActivity,
		mouse:         mouseCaptureEnabled(),
		markdownFor:   map[int]string{},
		eventCount:    0,
	}

	options := []tea.ProgramOption{
		tea.WithAltScreen(),
	}
	if m.mouse {
		options = append(options, tea.WithMouseCellMotion())
	}
	if readFromStdin {
		options = append(options, tea.WithInput(nil))
	}

	if _, err := tea.NewProgram(m, options...).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "zalo-tg-tui:", err)
		os.Exit(1)
	}
}

func eventReader() (io.Reader, bool, error) {
	if file := os.NewFile(uintptr(3), "zalo-tg-events"); file != nil {
		if _, err := file.Stat(); err == nil {
			return file, false, nil
		}
		_ = file.Close()
	}
	if stat, err := os.Stdin.Stat(); err == nil && (stat.Mode()&os.ModeCharDevice) == 0 {
		return os.Stdin, true, nil
	}
	return nil, false, errors.New("missing event stream on fd 3")
}

func signalParent() {
	parent, err := os.FindProcess(os.Getppid())
	if err != nil {
		return
	}
	_ = parent.Signal(os.Interrupt)
}

func mouseCaptureEnabled() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("ZALO_TG_TUI_MOUSE")))
	switch value {
	case "0", "false", "off", "no", "native":
		return false
	default:
		return true
	}
}
