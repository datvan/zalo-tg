package main

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/lipgloss"
)

func (m model) View() string {
	if m.selectMode && m.frozenView != "" {
		return m.clipboard + m.frozenView
	}
	return m.clipboard + m.renderFrame()
}

func (m model) renderFrame() string {
	width := m.width
	height := m.height
	if width <= 0 {
		width = 100
	}
	if height <= 0 {
		height = 30
	}
	if width < 56 || height < 14 {
		return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center,
			ui.muted.Render("Resize terminal to at least 56 × 14"),
		)
	}

	contentWidth := min(150, max(56, width-2))
	top := m.renderTopBar(contentWidth)
	status := m.renderStatusBar(contentWidth)
	footer := m.renderFooter(contentWidth)

	mainPanel := m.panel("activity", paneActivity, m.activity.Width+4, m.activity.Height+3, m.activity.View())
	panels := mainPanel

	if m.showDocs && contentWidth >= 104 {
		docsPanel := m.panel("help", paneDocs, m.docs.Width+4, m.docs.Height+3, m.docs.View())
		panels = lipgloss.JoinHorizontal(lipgloss.Top, mainPanel, "  ", docsPanel)
	} else if m.showDocs {
		panels = m.panel("help", paneDocs, contentWidth, height-4, m.markdownContent(contentWidth-4))
	}

	body := lipgloss.JoinVertical(lipgloss.Left, top, status, panels, footer)
	return ui.app.Width(width).Render(lipgloss.PlaceHorizontal(width-2, lipgloss.Center, body))
}

func (m model) renderTopBar(width int) string {
	online := m.state.Bridge == "online" && m.state.Telegram == "online" && m.state.Zalo == "online"
	phase := strings.ToLower(defaultString(m.state.Phase, "startup"))

	pulse := spinnerView(online, m.spinner.View(), m.frame)

	zaloStyle := lipgloss.NewStyle().Foreground(ui.palette.magenta).Bold(true)
	tgStyle := lipgloss.NewStyle().Foreground(ui.palette.cyan).Bold(true)
	arrowStyle := ui.muted

	zaloText := zaloStyle.Render("zalo")
	arrowText := arrowStyle.Render(" ⇄ ")
	tgText := tgStyle.Render("telegram")

	left := pulse + " " + zaloText + arrowText + tgText

	if width >= 74 {
		left += " " + m.signalRail(clamp(width/7, 10, 18), online)
	}
	if width >= 66 {
		left += " " + phaseBadge(phase)
	}

	right := ui.muted.Render(fmt.Sprintf("v%s  %s  up %s", defaultString(m.state.Version, "1.0.0"), time.Now().Format("15:04:05"), uptime()))
	if width < 104 {
		right = ui.muted.Render(fmt.Sprintf("%s  up %s", time.Now().Format("15:04:05"), uptime()))
	}
	if width < 78 {
		right = ui.muted.Render("up " + uptime())
	}
	if width < 62 {
		right = ""
	}

	barBg := ui.palette.surfaceAlt
	barStyle := ui.topBar.Width(width)
	bg := lipgloss.NewStyle().Background(barBg)

	line := alignLine(width, left, right)
	filled := fillLine(line, width)

	return bg.Render(barStyle.Render(filled))
}

func (m model) renderStatusBar(width int) string {
	compact := width < 82
	separator := ui.muted.Render(" ")

	left := lipgloss.JoinHorizontal(lipgloss.Left,
		m.statusSegment("bridge", m.state.Bridge, compact),
		separator,
		m.statusSegment("telegram", m.state.Telegram, compact),
		separator,
		m.statusSegment("zalo", m.state.Zalo, compact),
	)
	rightParts := []string{m.activitySparkline(10), fmt.Sprintf("%d topics", m.state.Topics), fmt.Sprintf("%d users", m.state.Users)}
	if m.activity.TotalLineCount() > m.activity.Height {
		rightParts = append([]string{m.scrollMeter(12)}, rightParts...)
	}
	right := ui.muted.Render(strings.Join(rightParts, "  "))
	if width < 98 || lipgloss.Width(left)+lipgloss.Width(right)+2 > width {
		right = ""
	}
	barBg := ui.palette.surface
	bg := lipgloss.NewStyle().Background(barBg)
	return bg.Render(ui.status.Width(width).Render(fillLine(alignLine(width, left, right), width)))
}

func (m model) statusSegment(name, value string, compact bool) string {
	color := statusColor(value)
	breath := breathing(m.frame, 48)

	if strings.ToLower(value) == "online" {
		shift := (math.Sin(float64(m.frame)*0.08) + 1) / 2
		color = lipgloss.Color(interpolateColor(string(color), string(ui.palette.cyan), shift*0.35))
	}

	dotChar := "●"
	if strings.ToLower(value) != "online" && strings.ToLower(value) != "error" {
		dotChar = strings.TrimSpace(m.spinner.View())
		if dotChar == "" {
			dotChar = "•"
		}
	}

	brightColor := brightenColor(color, breath)

	dot := lipgloss.NewStyle().Foreground(brightColor).Render(dotChar)

	label := name
	if compact {
		label = compactServiceName(name)
	}
	state := statusLabel(value)
	if compact {
		state = compactStatusLabel(value)
	}

	pillBg := ui.palette.elevated
	if strings.ToLower(value) == "online" {
		pillBg = ui.palette.surfaceAlt
	}
	stateText := lipgloss.NewStyle().
		Foreground(brightColor).
		Render(state)

	text := fmt.Sprintf(" %s %s %s ", dot, label, stateText)

	return lipgloss.NewStyle().
		Foreground(color).
		Background(pillBg).
		Bold(strings.ToLower(value) == "online" || strings.ToLower(value) == "error").
		Render(text)
}

func (m model) scrollMeter(width int) string {
	bar := m.progress
	bar.Width = width
	t := m.activity.ScrollPercent()
	col := interpolateColor(string(ui.palette.cyan), string(ui.palette.violet), t)
	bar2 := progress.New(
		progress.WithoutPercentage(),
		progress.WithSolidFill(col),
		progress.WithFillCharacters('━', '─'),
		progress.WithWidth(width),
	)
	return bar2.ViewAs(t)
}

func (m model) panel(title string, p pane, width, height int, content string) string {
	style := ui.panel
	if m.focus == p {
		style = ui.active
		borderColorStr := animatedBorderColor(m.frame)
		style = style.BorderForeground(lipgloss.Color(borderColorStr))
	}
	titleStyle := lipgloss.NewStyle().Foreground(ui.palette.muted).Bold(true)
	if m.focus == p {
		titleStyle = titleStyle.Foreground(ui.palette.ink)
	}
	if p == paneDocs {
		titleStyle = titleStyle.Foreground(ui.palette.muted)
		if m.focus == p {
			titleStyle = titleStyle.Foreground(ui.palette.ink)
		}
	}
	if m.quitting {
		titleStyle = titleStyle.Foreground(ui.palette.yellow)
	}
	innerWidth := max(1, width-style.GetHorizontalFrameSize())
	headerWidth := max(1, innerWidth-2)

	pulseColor := ui.palette.border
	if m.focus == p {
		pulseVal := breathing(m.frame, 48)
		pulseColor = lipgloss.Color(blendColors([]string{"#22D3EE", "#8B5CF6", "#EC4899"}, pulseVal))
	}
	dot := lipgloss.NewStyle().Foreground(pulseColor).Render("●")

	left := dot + " " + titleStyle.Render(title)
	right := ""

	if p == paneActivity {
		mode := lipgloss.NewStyle().Foreground(ui.palette.green).Render("live")
		if !m.activity.AtBottom() {
			mode = lipgloss.NewStyle().Foreground(ui.palette.yellow).Render(fmt.Sprintf("history %.0f%%", m.activity.ScrollPercent()*100))
		}
		right = ui.muted.Render(fmt.Sprintf("%d events  ", m.eventCount)) + mode
	} else {
		right = ui.muted.Render("glow/glamour")
	}
	if lipgloss.Width(left)+lipgloss.Width(right)+2 > headerWidth {
		right = ""
	}
	header := alignLine(headerWidth, left, right)

	if p == paneActivity && len(m.rows) == 0 {
		emptyContent := m.animatedEmptyContent(innerWidth)
		return renderBoxHeight(style, width, height, header+"\n"+emptyContent)
	}

	return renderBoxHeight(style, width, height, header+"\n"+content)
}

func (m model) animatedEmptyContent(width int) string {
	if width < 8 {
		return ui.muted.Render("waiting…")
	}
	pattern := emptyStateAnimation(width, m.frame)
	return pattern
}

func (m model) renderToast(width int) string {
	p := ui.palette
	remaining := m.toastTotal - m.toastFrame
	alpha := 1.0
	if remaining < 10 {
		alpha = float64(remaining) / 10.0
	}
	accentColor := interpolateColor(string(p.cyan), string(p.muted), 1.0-alpha)
	accentBar := lipgloss.NewStyle().Foreground(lipgloss.Color(accentColor)).Render("▎")
	text := lipgloss.NewStyle().Foreground(lipgloss.Color(accentColor)).Bold(true).Render(m.toast)

	box := lipgloss.NewStyle().
		Background(p.surfaceAlt).
		Padding(0, 1).
		Render(accentBar + " " + text)

	return ui.footer.Width(width).Render(
		lipgloss.PlaceHorizontal(width, lipgloss.Right, box),
	)
}

func (m model) renderFooter(width int) string {
	if m.quitting {
		return ui.footer.Width(width).Render(
			ui.muted.Render("shutting down..."),
		)
	}
	if m.selectMode {
		return ui.footer.Width(width).Render(
			lipgloss.NewStyle().Foreground(ui.palette.yellow).Render("select") +
				ui.muted.Render("  drag text  ·  Cmd+C copy  ·  s resume"),
		)
	}
	m.help.Width = width
	if m.help.ShowAll {
		return ui.footer.Width(width).Render(m.help.FullHelpView(m.keys.FullHelp()))
	}
	if m.toast != "" {
		return m.renderToast(width)
	}
	if m.flash != "" {
		return ui.footer.Width(width).Render(
			lipgloss.NewStyle().Foreground(ui.palette.green).Render(m.flash) +
				ui.muted.Render("  ·  drag selects activity rows  ·  wheel still scrolls"),
		)
	}
	if m.selection.has {
		start, end, _ := m.selection.bounds(len(m.rows))
		count := end - start + 1
		return ui.footer.Width(width).Render(commandBar(width,
			fmt.Sprintf("selected %d line%s", count, plural(count)),
			"release/y copy",
			"esc clear",
			"wheel scroll",
		))
	}
	if !m.mouse {
		return ui.footer.Width(width).Render(commandBar(width,
			"native mouse",
			"↑↓ scroll",
			"pg page",
			"g/G jump",
			"? help",
			"ctrl+c stop",
		))
	}
	return ui.footer.Width(width).Render(commandBar(width,
		"drag select",
		"↑↓ scroll",
		"wheel scroll",
		"g/G jump",
		"s select",
		"? help",
		"ctrl+c stop",
	))
}

func (m model) buildActivityRows(width int) []activityRow {
	if len(m.state.Events) == 0 {
		return m.emptyActivityRows(width)
	}

	rows := make([]activityRow, 0, len(m.state.Events)+2)
	for i, event := range m.state.Events {
		isNew := i == len(m.state.Events)-1
		rows = append(rows, activityRow{
			rendered: m.renderEventCard(event, width, isNew),
			plain:    plainEvent(event),
		})
	}
	if m.err != nil {
		text := "TUI event stream error: " + m.err.Error()
		rows = append(rows, activityRow{
			rendered: lipgloss.NewStyle().Foreground(ui.palette.red).Render(truncate(text, width)),
			plain:    text,
		})
	}
	if m.quitting {
		text := "Closing bridge dashboard safely…"
		rows = append(rows, activityRow{
			rendered: lipgloss.NewStyle().Foreground(ui.palette.yellow).Render(text),
			plain:    text,
		})
	}
	start, end, selected := m.selection.bounds(len(rows))
	if selected {
		for i := start; i <= end; i++ {
			plain := truncate(rows[i].plain, max(1, width-4))
			rows[i].rendered = lipgloss.NewStyle().
				Foreground(ui.palette.ink).
				Background(ui.palette.selection).
				Render(plain)
		}
	}
	return rows
}

func renderActivityRows(rows []activityRow) string {
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		lines = append(lines, row.rendered)
	}
	return strings.Join(lines, "\n")
}

func (m model) emptyActivityRows(width int) []activityRow {
	title := "waiting for bridge activity"
	if width < 40 {
		title = "waiting for events"
	}
	detail := "new Zalo and Telegram events will appear here"
	if width < 52 {
		detail = "new events appear here"
	}
	railWidth := clamp(width-2, 8, 30)
	rail := m.signalRail(railWidth, false)
	return []activityRow{
		{rendered: animatedGradientText(rail, m.frame, 6), plain: title},
		{rendered: lipgloss.NewStyle().Foreground(ui.palette.ink).Bold(true).Render(truncate(title, width)), plain: title},
		{rendered: ui.muted.Render(truncate(detail, width)), plain: detail},
		{rendered: lipgloss.NewStyle().Foreground(ui.palette.muted).Render(truncate("press ? for the Glow help pane", width)), plain: "press ? for the Glow help pane"},
	}
}

func (m model) signalRail(width int, online bool) string {
	if width <= 0 {
		return ""
	}
	head := m.frame % (width * 2)
	if head >= width {
		head = 2*width - head - 1
	}
	parts := make([]string, 0, width)
	for i := 0; i < width; i++ {
		distance := circularDistance(i, head, width)
		character := "─"
		color := ui.palette.border

		switch distance {
		case 0:
			character = "◆"
			if online {
				color = ui.palette.green
			} else {
				color = ui.palette.cyan
			}
			breath := breathing(m.frame, 24)
			color = lipgloss.Color(interpolateColor(string(color), string(ui.palette.violet), breath))
		case 1:
			character = "━"
			color = lipgloss.Color(animatedWaveColor(m.frame, i, width, 0.7))
		case 2:
			character = "─"
			color = lipgloss.Color(animatedWaveColor(m.frame, i, width, 0.4))
		default:
			if !online && (i+m.frame)%5 == 0 {
				character = "·"
				color = ui.palette.muted
			} else {
				if online && distance < width/3 {
					wave := math.Sin(float64(i+m.frame)*0.5) * 0.3
					c := interpolateColor(string(ui.palette.cyan), string(ui.palette.green), wave+0.5)
					color = lipgloss.Color(c)
				}
			}
		}
		parts = append(parts, lipgloss.NewStyle().Foreground(color).Render(character))
	}
	return strings.Join(parts, "")
}

func phaseBadge(phase string) string {
	color := ui.palette.blue
	switch {
	case strings.Contains(phase, "live"):
		color = ui.palette.green
	case strings.Contains(phase, "start"):
		color = ui.palette.cyan
	case strings.Contains(phase, "shutdown"), strings.Contains(phase, "stop"):
		color = ui.palette.yellow
	case strings.Contains(phase, "error"):
		color = ui.palette.red
	}
	return lipgloss.NewStyle().
		Foreground(ui.palette.panel).
		Background(color).
		Bold(true).
		Render(" " + strings.ToUpper(truncate(phase, 16)) + " ")
}

func (m model) activitySparkline(width int) string {
	if width <= 0 {
		return ""
	}
	events := m.state.Events
	if len(events) == 0 {
		return ui.muted.Render(strings.Repeat("·", width))
	}
	start := max(0, len(events)-width)
	cells := make([]string, 0, width)
	for i := start; i < len(events); i++ {
		character, baseColor := sparkCell(events[i].Tone)
		animOffset := float64(i+m.frame) * 0.1
		c := interpolateColor(string(baseColor), string(ui.palette.ink), math.Abs(math.Sin(animOffset))*0.3)
		cells = append(cells, lipgloss.NewStyle().Foreground(lipgloss.Color(c)).Render(character))
	}
	for len(cells) < width {
		cells = append([]string{ui.muted.Render("·")}, cells...)
	}
	return strings.Join(cells, "")
}

func sparkCell(tone string) (string, lipgloss.Color) {
	switch tone {
	case "success":
		return "▆", ui.palette.green
	case "info":
		return "▅", ui.palette.cyan
	case "warn":
		return "▇", ui.palette.yellow
	case "error":
		return "█", ui.palette.red
	default:
		return "▂", ui.palette.muted
	}
}

func (m model) renderEventCard(event activityEvent, width int, isNew bool) string {
	glyph, glyphColor := toneGlyph(event.Tone)
	level, toneColor := toneLevel(event.Tone)

	timePart := lipgloss.NewStyle().Foreground(ui.palette.muted).Render(event.Time)
	message := strings.ReplaceAll(event.Message, "\n", " ↵ ")

	if width < 48 {
		prefixWidth := lipgloss.Width(event.Time) + 3
		msgWidth := max(1, width-prefixWidth)
		line := fmt.Sprintf("%s %s %s",
			timePart,
			lipgloss.NewStyle().Foreground(glyphColor).Render(glyph),
			lipgloss.NewStyle().Foreground(ui.palette.ink).Render(truncate(message, msgWidth)),
		)
		if isNew {
			accentColor := lipgloss.Color(animatedWaveColor(m.frame, 0, 10, 0.9))
			glow := lipgloss.NewStyle().Foreground(accentColor).Render("▎") + " "
			return glow + line
		}
		return line
	}

	labelWidth := clamp(width/6, 10, 16)
	levelPart := lipgloss.NewStyle().
		Foreground(toneColor).
		Background(ui.palette.surfaceAlt).
		Render(" " + padRight(level, 5) + " ")
	labelPart := lipgloss.NewStyle().
		Foreground(labelColor(event.Label)).
		Render(padRight(truncate(event.Label, labelWidth), labelWidth))
	glyphPart := lipgloss.NewStyle().Foreground(glyphColor).Render(glyph)

	prefixWidth := 4 + 1 + lipgloss.Width(event.Time) + 2 + 1 + 2 + 7 + 2 + labelWidth + 2
	msgWidth := max(1, width-prefixWidth)
	msgPart := lipgloss.NewStyle().Foreground(ui.palette.ink).Render(truncate(message, msgWidth))

	accentColor := glyphColor
	if isNew {
		accentColor = lipgloss.Color(animatedWaveColor(m.frame, 0, 10, 0.9))
	}

	line := fmt.Sprintf("%s %s %s  %s  %s  %s",
		lipgloss.NewStyle().Foreground(accentColor).Render("│"),
		glyphPart,
		timePart,
		levelPart,
		labelPart,
		msgPart,
	)

	if isNew {
		waveFade := math.Abs(math.Sin(float64(m.frame) * 0.3))
		highlightColor := interpolateColor(string(ui.palette.surface), string(accentColor), waveFade*0.25)
		return lipgloss.NewStyle().Background(lipgloss.Color(highlightColor)).Render(line)
	}

	return line
}

func plainEvent(event activityEvent) string {
	level, _ := toneLevel(event.Tone)
	message := strings.ReplaceAll(event.Message, "\n", " ↵ ")
	return fmt.Sprintf("%s  %-5s  %-14s  %s", event.Time, level, truncate(event.Label, 14), message)
}
