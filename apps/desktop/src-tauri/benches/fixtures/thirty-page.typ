// Synthetic 30-page fixture for the baseline harness. Generated in-repo.
// Not downloaded. Libertinus Serif is an embedded Typst family.
#set page(paper: "a4", margin: 1.5cm)
#set text(font: "Libertinus Serif", size: 11pt)

#for i in range(30) [
  = Page #(i + 1)
  Synthetic thirty-page benchmark fixture. The text is here so a re-raster
  paints glyphs, not an empty page.
  #lorem(60)
  #if i < 29 [
    #pagebreak()
  ]
]
