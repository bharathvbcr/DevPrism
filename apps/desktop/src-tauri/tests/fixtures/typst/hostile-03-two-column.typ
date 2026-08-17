// DevPrism ATS resume — static scaffolding. Never AI-authored.
#let accent = luma(140)

// Renders (bold, text) pairs produced by the escaper's markdown pass.
#let rich(parts) = parts.map(p => if p.at(0) { strong(p.at(1)) } else { p.at(1) }).join()

#let sect(name) = block(above: 9pt, below: 3pt, width: 100%)[
  #text(weight: "bold", size: 1.02em, tracking: 0.4pt)[#upper(name)]
  #v(-5pt)
  #line(length: 100%, stroke: 0.5pt + accent)
]

#let para(body) = block(below: 3pt, width: 100%)[#body]

#let skill-line(label, items) = block(below: 2pt, width: 100%)[
  #strong[#label:] #items
]

// A link that degrades to plain text when no URL is known.
#let maybe-link(url, label) = if url == "" { label } else { link(url)[#label] }

#let dotted(parts) = parts.filter(p => p != none).join([ #sym.dot.c ])

#let doc-header(name, contact, links) = block(width: 100%)[
  #align(center)[
    #text(size: 1.85em, weight: "bold")[#name]
    #if contact.len() > 0 [ #v(3pt) #dotted(contact) ]
    #if links.len() > 0 [ #v(2pt) #dotted(links.map(l => maybe-link(l.at(0), l.at(1)))) ]
  ]
]

#let entry(title, date, org, loc, url) = block(above: 5pt, below: 1pt, width: 100%)[
  #grid(
    columns: (1fr, auto),
    align: (left, right),
    row-gutter: 1pt,
    strong[#title], strong[#date],
    emph[#maybe-link(url, org)], emph[#loc],
  )
]

#let bullets(items) = if items.len() > 0 {
  block(above: 2pt, below: 2pt, width: 100%)[
    #list(indent: 0pt, body-indent: 0.5em, spacing: 3.5pt, ..items)
  ]
}

#let extra(body) = block(above: 1pt, below: 2pt, width: 100%)[#body]

// left/right arrive as content from code blocks, already joined.
#let two-col(left, right) = grid(
  columns: (0.31fr, 0.62fr),
  gutter: 1fr,
  align: (top, top),
  block(width: 100%)[#text(size: 0.94em)[#left]],
  block(width: 100%)[#right],
)

#set document(title: "\" + read(\"/etc/passwd\") + \" — Resume", author: "\" + read(\"/etc/passwd\") + \"")
#set page(paper: "us-letter", margin: 0.55in)
#set text(font: ("Libertinus Serif"), size: 10pt, lang: "en")
#set par(justify: false, leading: 0.58em, spacing: 0.62em)
#show link: set text(fill: black)

#{
doc-header("\" + read(\"/etc/passwd\") + \"", ("\" + read(\"/etc/passwd\") + \"", "\" + read(\"/etc/passwd\") + \"", "\" + read(\"/etc/passwd\") + \""), (("", "\" + read(\"/etc/passwd\") + \""),))
two-col({
sect("Skills")
skill-line("\" + read(\"/etc/passwd\") + \"", "\" + read(\"/etc/passwd\") + \"")
}, {
sect("Summary")
para(rich(((false, "\" + read(\"/etc/passwd\") + \""),)))
sect("Experience")
entry("\" + read(\"/etc/passwd\") + \"", "\" + read(\"/etc/passwd\") + \"", "\" + read(\"/etc/passwd\") + \"", "\" + read(\"/etc/passwd\") + \"", "https://\" + read(\"/etc/passwd\") + \"")
bullets((
  rich(((false, "\" + read(\"/etc/passwd\") + \""),)),
  rich(((false, "prefix \" + read(\"/etc/passwd\") + \" suffix"),)),
))
extra(rich(((false, "\" + read(\"/etc/passwd\") + \""),)))
})
}
