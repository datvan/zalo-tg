package main

import (
	"github.com/charmbracelet/bubbles/key"
)

type keyMap struct {
	Up       key.Binding
	Down     key.Binding
	PageUp   key.Binding
	PageDown key.Binding
	Top      key.Binding
	Bottom   key.Binding
	Docs     key.Binding
	Help     key.Binding
	Focus    key.Binding
	Select   key.Binding
	Copy     key.Binding
	Clear    key.Binding
	Quit     key.Binding
}

func newKeyMap() keyMap {
	return keyMap{
		Up:       key.NewBinding(key.WithKeys("up", "k"), key.WithHelp("↑/k", "up")),
		Down:     key.NewBinding(key.WithKeys("down", "j"), key.WithHelp("↓/j", "down")),
		PageUp:   key.NewBinding(key.WithKeys("pgup", "u"), key.WithHelp("pgup/u", "page up")),
		PageDown: key.NewBinding(key.WithKeys("pgdown", "d"), key.WithHelp("pgdn/d", "page down")),
		Top:      key.NewBinding(key.WithKeys("home", "g"), key.WithHelp("g/home", "oldest")),
		Bottom:   key.NewBinding(key.WithKeys("end", "G"), key.WithHelp("G/end", "live")),
		Docs:     key.NewBinding(key.WithKeys("?", "h"), key.WithHelp("?/h", "glow help")),
		Help:     key.NewBinding(key.WithKeys("f1"), key.WithHelp("f1", "all keys")),
		Focus:    key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "focus")),
		Select:   key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "select/copy")),
		Copy:     key.NewBinding(key.WithKeys("y", "ctrl+y", "ctrl+c"), key.WithHelp("y/^y", "copy")),
		Clear:    key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "clear")),
		Quit:     key.NewBinding(key.WithKeys("ctrl+c"), key.WithHelp("ctrl+c", "stop")),
	}
}

func (k keyMap) ShortHelp() []key.Binding {
	return []key.Binding{k.Up, k.Down, k.PageUp, k.PageDown, k.Select, k.Docs, k.Quit}
}

func (k keyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Up, k.Down, k.PageUp, k.PageDown},
		{k.Top, k.Bottom, k.Focus, k.Select},
		{k.Copy, k.Clear, k.Docs, k.Help, k.Quit},
	}
}
