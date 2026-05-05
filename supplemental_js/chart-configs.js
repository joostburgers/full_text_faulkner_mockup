import { CONFIG } from './app-config.js';
import { faulknerBaseLayout, defaultConfig } from './faulkner-chart-styles.js';

// Chart configurations leveraging Faulkner styles and application constants. Most of the visuals on the pages can be modified here.

export const CHART_CONFIGS = {
    // Base layout optimized for character charts
    PIE_LAYOUT: {
        ...faulknerBaseLayout,
        showlegend: false,
        margin: { l: 10, r: 10, b: 0, t: 0, pad: 0 },
		title: { text: "" } // Override title for pie charts
    },

    // Sunburst layout using faulkner styles
    SUNBURST_LAYOUT: {
        ...faulknerBaseLayout,
        margin: { l: 0, r: 0, b: 0, t: 0 },
        height: 500,
        title: { text: "" }, // Override title
        showlegend: false
    },

    // Events layout using faulkner styles
    EVENTS_LAYOUT_BASE: {
        ...faulknerBaseLayout,
        font: {
            ...faulknerBaseLayout.font,
            size: 14
        },
		showlegend: false,
        margin: { l: 75, r: 50, b: 100, t: 50, pad: 4 }
    },

    // Enhanced plotly config based on defaultConfig
    PLOTLY: {
        ...defaultConfig,
		responsive: true,
        staticPlot: false
    },

    // Font configurations leveraging faulkner styles - NO COLOR MANAGEMENT
    FONTS: {
        pieText: {
            family: faulknerBaseLayout.font.family,
            size: CONFIG.STYLING.FONTS.PIE_TEXT
            // Removed: color property - let Plotly auto-adjust
        },
        hoverLabel: {
            family: faulknerBaseLayout.font.family,
            size: CONFIG.STYLING.FONTS.HOVER_LABEL,

        },
        outsideText: {
            family: faulknerBaseLayout.font.family,
            size: CONFIG.STYLING.FONTS.OUTSIDE_TEXT,
            color: "white"
        }
    },


    EVENTS: {
        CHART_RANGES: {
            SUTPEN_X: [0.5, 9],
            SUTPEN_Y: [0.5, 3.5],
            ABSALOM_X: [-25, 660],
            ABSALOM_Y: [-50, 699]
        },
        TICK_VALUES: {
            SUTPEN_X: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            SUTPEN_Y: [1, 2, 3],
            ABSALOM_X: [1, 40, 93, 150, 236, 287, 375, 496, 621],
            ABSALOM_X_TEXT: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            ABSALOM_Y: [100, 200, 300, 400, 500, 600, 700]
        },
        MARKER_SIZES: {
            SMALL: 5,
            LARGE: 20
        },
        OPACITIES: {
            LOW: 0.2,
            MEDIUM: 0.5,
            HIGH: 0.8
        }
    },


    LANGUAGE: {
        WORDS_LAYOUT: {
            ...faulknerBaseLayout,
            title: { text: "" },
            showlegend: false,
            xaxis: { showgrid: false, title: { text: "Novel" } },
            yaxis: { title: { text: "Words per Sentence" }, showgrid: false, zeroline: false },
          
        },
        PARENTHESIS_LAYOUT: {
            ...faulknerBaseLayout,
            title: { text: "" },
            xaxis: { showgrid: false, zeroline: false, showline: false, tickmode: 'array' },
            yaxis: {
                text: "Nesting Level", showgrid: false, zeroline: false, showline: false,
                linewidth: 0, tickmode: "array", tickvals: [0, 1, 2, 3, 4],
                ticktext: ["Main Text", "1: ()", "2: (())", "3: ((()))", "4: (((())))"]
            }
        }
    }
};