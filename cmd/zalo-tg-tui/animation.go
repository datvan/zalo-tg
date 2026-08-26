package main

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

func lerp(a, b float64, t float64) float64 {
	return a + (b-a)*t
}

func clampF(t float64) float64 {
	if t < 0 {
		return 0
	}
	if t > 1 {
		return 1
	}
	return t
}

func parseHexColor(hex string) (float64, float64, float64) {
	hex = strings.TrimPrefix(hex, "#")
	if len(hex) != 6 {
		return 0, 0, 0
	}
	r, _ := strconv.ParseInt(hex[0:2], 16, 64)
	g, _ := strconv.ParseInt(hex[2:4], 16, 64)
	b, _ := strconv.ParseInt(hex[4:6], 16, 64)
	return float64(r), float64(g), float64(b)
}

func rgbToHex(r, g, b float64) string {
	ri := clamp(int(math.Round(r)), 0, 255)
	gi := clamp(int(math.Round(g)), 0, 255)
	bi := clamp(int(math.Round(b)), 0, 255)
	return fmt.Sprintf("#%02X%02X%02X", ri, gi, bi)
}

func interpolateColor(a, b string, t float64) string {
	t = clampF(t)
	r1, g1, b1 := parseHexColor(a)
	r2, g2, b2 := parseHexColor(b)
	return rgbToHex(
		lerp(r1, r2, t),
		lerp(g1, g2, t),
		lerp(b1, b2, t),
	)
}

func blendColors(colors []string, t float64) string {
	if len(colors) == 0 {
		return "#000000"
	}
	if len(colors) == 1 {
		return colors[0]
	}
	t = clampF(t)
	n := float64(len(colors) - 1)
	idx := int(t * n)
	if idx >= len(colors)-1 {
		return colors[len(colors)-1]
	}
	localT := (t*n - float64(idx)) / (1.0 / n)
	return interpolateColor(colors[idx], colors[idx+1], localT)
}

func breathing(frame int, period int) float64 {
	if period <= 0 {
		return 0
	}
	return (math.Sin(2*math.Pi*float64(frame)/float64(period)) + 1) / 2
}

func brightenColor(color lipgloss.Color, amount float64) lipgloss.Color {
	hex := string(color)
	r, g, b := parseHexColor(hex)
	r = lerp(r, 255, amount*0.3)
	g = lerp(g, 255, amount*0.3)
	b = lerp(b, 255, amount*0.3)
	return lipgloss.Color(rgbToHex(r, g, b))
}

func animatedBorderColor(frame int) string {
	t := (math.Sin(float64(frame)*0.1) + 1) / 2
	return blendColors([]string{"#22D3EE", "#8B5CF6", "#EC4899", "#22D3EE"}, t)
}

func animatedWaveColor(frame, pos, total int, intensity float64) string {
	t := (math.Sin(float64(pos+frame)*0.5) + 1) / 2
	t = t*intensity + (1-intensity)/2
	return interpolateColor("#22D3EE", "#8B5CF6", t)
}

func animatedGradientText(text string, frame int, speed int) string {
	if len(text) == 0 {
		return ""
	}
	chars := []rune(text)
	parts := make([]string, len(chars))
	gradColors := []string{"#22D3EE", "#8B5CF6", "#EC4899", "#FBBF24", "#22D3EE"}
	for i, ch := range chars {
		t := (float64(i)/float64(len(chars)) + float64(frame)/float64(speed)) / 1.0
		t = math.Mod(t, 1.0)
		if t < 0 {
			t += 1.0
		}
		c := blendColors(gradColors, t)
		parts[i] = lipgloss.NewStyle().Foreground(lipgloss.Color(c)).Render(string(ch))
	}
	return strings.Join(parts, "")
}

func emptyStateAnimation(width int, frame int) string {
	if width < 16 {
		return ""
	}
	w := min(width-2, 30)
	center := w / 2
	parts := make([]string, w)
	for i := 0; i < w; i++ {
		dist := int(math.Abs(float64(i - center)))
		wave := math.Sin(float64(frame)*0.15 + float64(i)*0.4)
		brightness := (wave + 1) / 2
		brightness = brightness * (1.0 - float64(dist)/float64(center+1))
		if brightness < 0.1 {
			brightness = 0.1
		}
		chars := []string{"·", "░", "▒", "▓", "█"}
		ci := int(brightness * float64(len(chars)-1))
		if ci >= len(chars) {
			ci = len(chars) - 1
		}
		ch := chars[ci]
		t := float64(i)/float64(w) + float64(frame)*0.02
		t = math.Mod(t, 1.0)
		if t < 0 {
			t += 1.0
		}
		c := blendColors([]string{"#22D3EE", "#8B5CF6", "#EC4899", "#22D3EE"}, t)
		parts[i] = lipgloss.NewStyle().Foreground(lipgloss.Color(c)).Render(ch)
	}
	return strings.Join(parts, "")
}


