package main

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestSelectedActivityRowsDoNotFillViewportWidth(t *testing.T) {
	m := selectedRowsTestModel()

	const viewportWidth = 80
	rows := m.buildActivityRows(viewportWidth)
	if len(rows) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(rows))
	}

	for i, row := range rows {
		if strings.Contains(row.rendered, "\n") {
			t.Fatalf("selected row %d contains a newline: %q", i, row.rendered)
		}
		if width := lipgloss.Width(row.rendered); width >= viewportWidth-1 {
			t.Fatalf("selected row %d reaches viewport edge: width=%d viewport=%d", i, width, viewportWidth)
		}
	}

	m.rows = rows
	text := m.selectedText()
	if !strings.Contains(text, "loading saved credentials") ||
		!strings.Contains(text, "menu synchronized") ||
		!strings.Contains(text, "Loaded 34 contact names") {
		t.Fatalf("selected text did not include full row content: %q", text)
	}
}

func TestCopySelectionClearsHighlightLikeOpenCode(t *testing.T) {
	m := selectedRowsTestModel()
	m.width = 100
	m.height = 20
	m.activity.Width = 80
	m.activity.Height = 10
	m.rows = m.buildActivityRows(80)

	cmd := m.copySelection()
	if cmd == nil {
		t.Fatal("expected clipboard command")
	}
	if m.selection.has || m.selection.active {
		t.Fatalf("copy should clear selection, got %#v", m.selection)
	}
	if m.clipboard == "" {
		t.Fatal("expected OSC52 clipboard fallback to be queued in view")
	}
	if !strings.HasPrefix(m.toast, "copied 3 lines") {
		t.Fatalf("unexpected toast: %q", m.toast)
	}
}

func selectedRowsTestModel() model {
	return model{
		state: serviceState{
			Events: []activityEvent{
				{Time: "03:15:19", Label: "ZALO LOGIN", Message: "loading saved credentials…", Tone: "info"},
				{Time: "03:15:19", Label: "COMMANDS", Message: "menu synchronized", Tone: "success"},
				{Time: "03:15:20", Label: "ZALO", Message: "Loaded 34 contact names (34 aliases, 618 friends)", Tone: "muted"},
			},
		},
		selection: selectionState{has: true, anchor: 0, cursor: 2},
	}
}
