## Frontend Style Guide

Examples should follow these design conventions:

**Color Palette (Dark Theme)**
- Primary accent: `#ff4f00` (orange) for interactive elements and highlights
- Background: `#000000` (main), `#1c1c1e` (cards/containers)
- Borders: `#2c2c2e`
- Input backgrounds: `#2c2c2e` with border `#3a3a3c`
- Text: `#ffffff` (primary), `#8e8e93` (secondary/muted)
- Success: `#30d158` (green)
- Warning: `#ff4f00` (orange)
- Danger: `#ff3b30` (red)
- Purple: `#bf5af2` (for special states like rollback)

**Typography**
- UI: System fonts (`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, sans-serif`)
- Code: `ui-monospace, SFMono-Regular, 'SF Mono', Consolas, monospace`
- Sizes: 14-16px body, 12-13px labels, large numbers 48-72px

**Sizing & Spacing**
- Border radius: 8px (cards/containers/buttons), 6px (inputs/badges)
- Section padding: 20-24px
- Gap between items: 12px
- Transitions: 200ms ease for all interactive states

**Button Styles**
- Padding: 12px 20px
- Border: none
- Border radius: 8px
- Font size: 14px, weight 600
- Hover: none (no hover state)
- Disabled: 50% opacity, `cursor: not-allowed`

**CSS Approach**
- Plain CSS in `<style>` tag within index.html (no preprocessors or Tailwind)
- Class-based selectors with state modifiers (`.active`, `.complete`, `.running`)
- Focus states use primary accent color (`#ff4f00`) for borders with subtle box-shadow

**Spacing System**
- Base unit: 4px
- Scale: 4px, 8px, 12px, 16px, 20px, 24px, 32px, 48px
- Component internal padding: 12-16px
- Section/card padding: 20px
- Card header padding: 16px 20px
- Gap between related items: 8-12px
- Gap between sections: 24-32px
- Margin between major blocks: 32px

**Iconography**
- Icon library: [Lucide](https://lucide.dev/) (React: `lucide-react`)
- Standard sizes: 16px (inline/small), 20px (buttons/UI), 24px (standalone/headers)
- Icon color: inherit from parent text color, or use `currentColor`
- Icon-only buttons must include `aria-label` for accessibility
- Stroke width: 2px (default), 1.5px for smaller icons

**Component Patterns**

*Buttons*
- Primary: `#ff4f00` background, white text
- Secondary: `#2c2c2e` background, white text
- Ghost: transparent background, `#ff4f00` text
- Danger: `#ff3b30` background, white text
- Success: `#30d158` background, white text
- Disabled: 50% opacity, `cursor: not-allowed`

*Form Inputs*
- Background: `#2c2c2e`
- Border: 1px solid `#3a3a3c`
- Border radius: 8px
- Padding: 12px 16px
- Focus: border-color `#ff4f00`, box-shadow `0 0 0 3px rgba(255, 79, 0, 0.2)`
- Placeholder text: `#6e6e73`

*Cards/Containers*
- Background: `#1c1c1e`
- Border: 1px solid `#2c2c2e`
- Border radius: 8px
- Padding: 20px
- Box shadow: `0 1px 3px rgba(0, 0, 0, 0.3)`
- Header style (when applicable):
  - Background: `#2c2c2e`
  - Padding: 16px 20px
  - Font size: 18px, weight 600
  - Border bottom: 1px solid `#2c2c2e`
  - Border radius: 8px 8px 0 0 (top corners only)
  - Negative margin to align with card edges: `-20px -20px 20px -20px`

*Modals/Overlays*
- Backdrop: `rgba(0, 0, 0, 0.75)`
- Modal background: `#1c1c1e`
- Border radius: 8px
- Max-width: 480px (small), 640px (medium), 800px (large)
- Padding: 24px
- Close button: top-right, 8px from edges

*Lists*
- Item padding: 12px 16px
- Dividers: 1px solid `#2c2c2e`
- Hover background: `#2c2c2e`
- Selected/active background: `rgba(255, 79, 0, 0.15)`

*Badges/Tags*
- Padding: 4px 8px
- Border radius: 6px
- Font size: 12px
- Font weight: 500

*Tabs*
- Container: `border-bottom: 1px solid #2c2c2e`, flex-wrap for overflow
- Tab: `padding: 12px 16px`, no background, `border-radius: 0`
- Tab border: `border-bottom: 2px solid transparent`, `margin-bottom: -1px`
- Tab text: `#8e8e93` (muted), font-weight 600, font-size 14px
- Active tab: `color: #ffffff`, `border-bottom-color: #ff4f00`
- Hover: none (no hover state)
- Transition: `color 200ms ease, border-color 200ms ease`

**UI States**

*Loading States*
- Spinner: 20px for inline, 32px for page-level
- Skeleton placeholders: `#2c2c2e` background with subtle pulse animation
- Loading text: "Loading..." in muted color
- Button loading: show spinner, disable interaction, keep button width stable

*Empty States*
- Center content vertically and horizontally
- Icon: 48px, muted color (`#6e6e73`)
- Heading: 18px, primary text color
- Description: 14px, muted color
- Optional action button below description

*Error States*
- Inline errors: `#ff3b30` text below input, 12px font size
- Error banners: `#ff3b30` left border (4px), `rgba(255, 59, 48, 0.1)` background
- Form validation: highlight input border in `#ff3b30`
- Error icon: Lucide `AlertCircle` or `XCircle`

*Disabled States*
- Opacity: 50%
- Cursor: `not-allowed`
- No hover/focus effects
- Preserve layout (don't collapse or hide)

*Success States*
- Color: `#30d158`
- Icon: Lucide `CheckCircle` or `Check`
- Toast/banner: `rgba(48, 209, 88, 0.1)` background with green left border


