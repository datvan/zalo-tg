package main

import (
	"time"

	"github.com/charmbracelet/lipgloss"
)

type palette struct {
	ink        lipgloss.Color
	muted      lipgloss.Color
	panel      lipgloss.Color
	surface    lipgloss.Color
	surfaceAlt lipgloss.Color
	elevated   lipgloss.Color
	border     lipgloss.Color
	selection  lipgloss.Color
	magenta    lipgloss.Color
	cyan       lipgloss.Color
	green      lipgloss.Color
	yellow     lipgloss.Color
	red        lipgloss.Color
	blue       lipgloss.Color
	orange     lipgloss.Color
	violet     lipgloss.Color
	shadow     lipgloss.Color
	terminal   lipgloss.AdaptiveColor
	gradStart  lipgloss.Color
	gradMid    lipgloss.Color
	gradEnd    lipgloss.Color
}

type designSystem struct {
	palette palette

	app          lipgloss.Style
	topBar       lipgloss.Style
	status       lipgloss.Style
	panel        lipgloss.Style
	active       lipgloss.Style
	card         lipgloss.Style
	cardTitle    lipgloss.Style
	footer       lipgloss.Style
	pill         lipgloss.Style
	brand        lipgloss.Style
	muted        lipgloss.Style
	accentDot    lipgloss.Style
	gradientEdge lipgloss.Style
	glowBar      lipgloss.Style
}

func newPalette() palette {
	return palette{
		ink:       "#E2E8F0",
		muted:     "#64748B",
		panel:     "#0A0E17",
		surface:   "#111827",
		surfaceAlt: "#1E293B",
		elevated:  "#334155",
		border:    "#2D3A4A",
		selection: "#1E3A5F",
		magenta:   "#E879F9",
		cyan:      "#22D3EE",
		green:     "#10B981",
		yellow:    "#F59E0B",
		red:       "#EF4444",
		blue:      "#3B82F6",
		orange:    "#F97316",
		violet:    "#8B5CF6",
		shadow:    "#05070A",
		terminal:  lipgloss.AdaptiveColor{Light: "#1E293B", Dark: "#E2E8F0"},
		gradStart: "#06B6D4",
		gradMid:   "#8B5CF6",
		gradEnd:   "#EC4899",
	}
}

func newDesignSystem(p palette) designSystem {
	return designSystem{
		palette: p,
		app: lipgloss.NewStyle().
			Foreground(p.terminal).
			Padding(0, 1),
		topBar: lipgloss.NewStyle().
			Foreground(p.ink).
			Background(p.surfaceAlt).
			Padding(0, 0),
		status: lipgloss.NewStyle().
			Foreground(p.muted).
			Background(p.surface).
			Padding(0, 0),
		panel: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(p.border).
			Foreground(p.ink).
			Padding(0, 1),
		active: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(p.cyan).
			Foreground(p.ink).
			Padding(0, 1),
		card: lipgloss.NewStyle().
			Foreground(p.ink).
			Padding(0, 1),
		cardTitle: lipgloss.NewStyle().
			Foreground(p.muted).
			Bold(false),
		footer: lipgloss.NewStyle().
			Foreground(p.muted),
		pill: lipgloss.NewStyle().
			Foreground(p.ink).
			Bold(true).
			Padding(0, 1),
		brand: lipgloss.NewStyle().
			Bold(true).
			Foreground(p.ink),
		muted: lipgloss.NewStyle().
			Foreground(p.muted),
		accentDot: lipgloss.NewStyle().
			Foreground(p.border),
		gradientEdge: lipgloss.NewStyle().
			Foreground(p.violet),
		glowBar: lipgloss.NewStyle().
			Foreground(p.cyan),
	}
}

var ui = newDesignSystem(newPalette())
var startedAt = time.Now()
