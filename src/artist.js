import createColorPalette from "./color-palette";
import { fitImage, fillImage } from "./image-helper";
import log from "./log";

const nominalPenDiameter = 4;
// Use the full pen diameter to prevent blank lines
const realPenDiameter = 4;
const scaleImage = fitImage;

export default function (canvas, toolbar) {
    const colorPalette = createColorPalette(toolbar.getColors());
    const availablePenDiameters = toolbar.getPenDiameters().sort((a, b) => a - b);
    const effectiveDrawingSize = {
        width: canvas.size.width / realPenDiameter,
        height: canvas.size.height / realPenDiameter
    };

    // State tracking for optimization
    let currentColor = null;
    let currentPenDiameter = null;
    let currentTool = null;

    const getMostCommonColor = function (imageData) {
        const colorCounts = {};
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            const color = { r: data[i], g: data[i + 1], b: data[i + 2] };
            const paletteColor = colorPalette.getClosestColor(color, {});
            const key = JSON.stringify(paletteColor);
            colorCounts[key] = (colorCounts[key] || 0) + 1;
        }

        const mostCommon = Object.keys(colorCounts)
            .reduce((c1, c2) => colorCounts[c1] > colorCounts[c2] ? c1 : c2);
        return JSON.parse(mostCommon);
    };

    const fillCanvas = function (color) {
        return [
            function () {
                currentTool = 'fill';
                currentColor = color;
                toolbar.setFillTool();
                toolbar.setColor(color);
                canvas.draw([
                    { x: 0, y: 0 },
                    { x: 0, y: 0 }
                ]);
            }
        ];
    };

    // Universal edge detection using gradient magnitude
    const detectEdges = function (imageData) {
        const data = imageData.data;
        const width = imageData.width;
        const height = imageData.height;
        const edges = [];

        const getPixelIntensity = (x, y) => {
            if (x < 0 || x >= width || y < 0 || y >= height) return 0;
            const i = (y * width + x) * 4;
            return (data[i] + data[i + 1] + data[i + 2]) / 3;
        };

        // Sobel edge detection - works for any image type
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const gx = 
                    -1 * getPixelIntensity(x - 1, y - 1) + 1 * getPixelIntensity(x + 1, y - 1) +
                    -2 * getPixelIntensity(x - 1, y) + 2 * getPixelIntensity(x + 1, y) +
                    -1 * getPixelIntensity(x - 1, y + 1) + 1 * getPixelIntensity(x + 1, y + 1);

                const gy = 
                    -1 * getPixelIntensity(x - 1, y - 1) + -2 * getPixelIntensity(x, y - 1) + -1 * getPixelIntensity(x + 1, y - 1) +
                    1 * getPixelIntensity(x - 1, y + 1) + 2 * getPixelIntensity(x, y + 1) + 1 * getPixelIntensity(x + 1, y + 1);

                const magnitude = Math.sqrt(gx * gx + gy * gy);
                
                // Adaptive threshold based on image characteristics
                const threshold = 30; // Lower threshold for more detail
                if (magnitude > threshold) {
                    const i = (y * width + x) * 4;
                    const color = { r: data[i], g: data[i + 1], b: data[i + 2] };
                    edges.push({ 
                        x, y, 
                        color: colorPalette.getClosestColor(color, {}), 
                        magnitude,
                        direction: Math.atan2(gy, gx) // Edge direction for stroke orientation
                    });
                }
            }
        }

        return edges.sort((a, b) => b.magnitude - a.magnitude);
    };

    // Create adaptive sampling based on image complexity
    const createAdaptiveSampling = function (imageData, fillColor) {
        const data = imageData.data;
        const width = imageData.width;
        const height = imageData.height;
        const samples = [];
        
        // Analyze image complexity to determine sampling density
        let totalVariation = 0;
        let sampleCount = 0;
        
        for (let y = 0; y < height; y += 4) {
            for (let x = 0; x < width; x += 4) {
                if (x + 4 < width && y + 4 < height) {
                    const i1 = (y * width + x) * 4;
                    const i2 = ((y + 4) * width + (x + 4)) * 4;
                    const variation = Math.abs(data[i1] - data[i2]) + 
                                    Math.abs(data[i1 + 1] - data[i2 + 1]) + 
                                    Math.abs(data[i1 + 2] - data[i2 + 2]);
                    totalVariation += variation;
                    sampleCount++;
                }
            }
        }
        
        const avgVariation = totalVariation / sampleCount;
        // More complex images get denser sampling
        const sampleStep = avgVariation > 50 ? 2 : avgVariation > 25 ? 3 : 4;
        
        log(`Image complexity: ${avgVariation.toFixed(1)}, using ${sampleStep}px sampling`);
        
        // Sample with adaptive density
        for (let y = 0; y < height; y += sampleStep) {
            for (let x = 0; x < width; x += sampleStep) {
                const i = (y * width + x) * 4;
                const color = { r: data[i], g: data[i + 1], b: data[i + 2] };
                const paletteColor = colorPalette.getClosestColor(color, {});
                
                if (JSON.stringify(paletteColor) !== JSON.stringify(fillColor)) {
                    samples.push({ x, y, color: paletteColor });
                }
            }
        }
        
        return samples;
    };

    // Create natural strokes in multiple directions
    const createNaturalStrokes = function (samples) {
        const strokes = [];
        const used = new Set();
        const maxStrokeLength = 15;
        const connectionDistance = 4;
        
        // Sort samples for better stroke creation
        samples.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
        
        for (let i = 0; i < samples.length; i++) {
            if (used.has(i)) continue;
            
            const startSample = samples[i];
            const stroke = [startSample];
            used.add(i);
            
            // Try to extend stroke in natural directions
            let lastSample = startSample;
            let extended = true;
            
            while (extended && stroke.length < maxStrokeLength) {
                extended = false;
                let bestCandidate = null;
                let bestDistance = Infinity;
                let bestIndex = -1;
                
                for (let j = 0; j < samples.length; j++) {
                    if (used.has(j)) continue;
                    
                    const sample = samples[j];
                    
                    // Must be same color
                    if (JSON.stringify(sample.color) !== JSON.stringify(lastSample.color)) continue;
                    
                    const distance = Math.sqrt(
                        Math.pow(sample.x - lastSample.x, 2) + 
                        Math.pow(sample.y - lastSample.y, 2)
                    );
                    
                    if (distance <= connectionDistance && distance < bestDistance) {
                        bestDistance = distance;
                        bestCandidate = sample;
                        bestIndex = j;
                    }
                }
                
                if (bestCandidate) {
                    stroke.push(bestCandidate);
                    used.add(bestIndex);
                    lastSample = bestCandidate;
                    extended = true;
                }
            }
            
            if (stroke.length >= 1) {
                strokes.push({
                    points: stroke,
                    color: startSample.color,
                    length: stroke.length
                });
            }
        }
        
        return strokes;
    };

    // Create edge-following strokes
    const createEdgeStrokes = function (edges) {
        const edgeStrokes = [];
        const maxEdges = Math.min(edges.length, 300); // Limit for performance
        
        for (let i = 0; i < maxEdges; i++) {
            const edge = edges[i];
            
            // Create short strokes following edge direction
            const directionX = Math.cos(edge.direction);
            const directionY = Math.sin(edge.direction);
            
            const strokePoints = [
                { x: edge.x, y: edge.y },
                { x: edge.x + directionX * 2, y: edge.y + directionY * 2 },
                { x: edge.x + directionX * 3, y: edge.y + directionY * 3 }
            ];
            
            edgeStrokes.push({
                points: strokePoints,
                color: edge.color,
                length: strokePoints.length,
                isEdge: true
            });
        }
        
        return edgeStrokes;
    };

    // Universal stroke drawing with adaptive pen sizes
    const drawUniversalStrokes = function (strokes, offset) {
        const commands = [];
        
        // Group strokes by color
        const colorGroups = {};
        for (const stroke of strokes) {
            const colorKey = JSON.stringify(stroke.color);
            if (!colorGroups[colorKey]) {
                colorGroups[colorKey] = [];
            }
            colorGroups[colorKey].push(stroke);
        }

        // Draw each color group
        for (const [colorKey, strokeGroup] of Object.entries(colorGroups)) {
            const color = JSON.parse(colorKey);
            
            // Set color once for the group
            commands.push(function () {
                if (currentTool !== 'pen') {
                    toolbar.setPenTool();
                    currentTool = 'pen';
                }
                
                if (JSON.stringify(currentColor) !== JSON.stringify(color)) {
                    toolbar.setColor(color);
                    currentColor = color;
                }
            });

            // Group by pen diameter based on stroke characteristics
            const diameterGroups = {};
            for (const stroke of strokeGroup) {
                let diameter;
                
                if (stroke.isEdge) {
                    diameter = nominalPenDiameter; // Precise edges
                } else if (stroke.length > 10) {
                    diameter = availablePenDiameters[Math.min(3, availablePenDiameters.length - 1)]; // Large areas
                } else if (stroke.length > 5) {
                    diameter = availablePenDiameters[Math.min(2, availablePenDiameters.length - 1)]; // Medium areas
                } else {
                    diameter = availablePenDiameters[Math.min(1, availablePenDiameters.length - 1)]; // Fine details
                }
                
                if (!diameterGroups[diameter]) {
                    diameterGroups[diameter] = [];
                }
                diameterGroups[diameter].push(stroke);
            }

            // Draw each diameter group
            for (const [diameter, strokes] of Object.entries(diameterGroups)) {
                const penDiameter = parseInt(diameter);
                
                commands.push(function () {
                    if (currentPenDiameter !== penDiameter) {
                        toolbar.setPenDiameter(penDiameter);
                        currentPenDiameter = penDiameter;
                    }
                });

                // Draw all strokes with this diameter
                for (const stroke of strokes) {
                    commands.push(function () {
                        const coords = stroke.points.map(point => ({
                            x: (point.x + offset.x) * realPenDiameter,
                            y: (point.y + offset.y) * realPenDiameter
                        }));
                        
                        // Ensure minimum stroke length
                        if (coords.length === 1) {
                            coords.push({
                                x: coords[0].x + 1,
                                y: coords[0].y
                            });
                        }
                        
                        canvas.draw(coords);
                    });
                }
            }
        }

        return commands;
    };

    return {
        draw: function (image) {
            const scaledImage = scaleImage(effectiveDrawingSize, image);

            log("Generating universal drawing commands...");
            let commands = [];

            // Reset state tracking
            currentColor = null;
            currentPenDiameter = null;
            currentTool = null;

            // Fill with most common color
            const mostCommonColor = getMostCommonColor(scaledImage);
            commands = commands.concat(fillCanvas(mostCommonColor));

            // Detect edges for structure (works for any image)
            log("Detecting edges...");
            const edges = detectEdges(scaledImage);
            const edgeStrokes = createEdgeStrokes(edges);
            
            // Create adaptive sampling based on image complexity
            log("Creating adaptive sampling...");
            const samples = createAdaptiveSampling(scaledImage, mostCommonColor);
            
            // Create natural strokes
            log("Creating natural strokes...");
            const naturalStrokes = createNaturalStrokes(samples);
            
            // Combine all strokes
            const allStrokes = [...edgeStrokes, ...naturalStrokes];
            
            // Sort by priority: edges first for structure, then by stroke length
            allStrokes.sort((a, b) => {
                if (a.isEdge && !b.isEdge) return -1;
                if (!a.isEdge && b.isEdge) return 1;
                return b.length - a.length;
            });

            let drawingOffset = {
                x: (effectiveDrawingSize.width - scaledImage.width) / 2 + 0.5,
                y: (effectiveDrawingSize.height - scaledImage.height) / 2 + 0.5
            };
            
            commands = commands.concat(drawUniversalStrokes(allStrokes, drawingOffset));

            log(`${commands.length} universal commands generated (${allStrokes.length} strokes, ${edges.length} edges detected).`);
            return commands;
        }
    };
};
