import re
import shutil

shutil.copyfile('sound_and_the_fury_model/dy-mockup.css', 'a_rose_for_emily_model/dy-mockup.css')
shutil.copyfile('sound_and_the_fury_model/dy-mockup.js', 'a_rose_for_emily_model/dy-mockup.js')

P = 'a_rose_for_emily_model/dy-mockup.js'
s = open(P, encoding='utf-8').read()
CFG = (
    "\tvar DY_TEXT = {\n"
    "\t\tcode:             'RE',\n"
    "\t\tprefix:           're_',\n"
    "\t\tnarrativePresent: 1924,  // stored in Drupal upstream\n"
    "\t\t// Matches the .ft-section-num text emitted by build_text_data.py\n"
    "\t\tsectionRe:        /^[IVXivx]+$/\n"
    "\t};"
)
s, n = re.compile(r"\tvar DY_TEXT = \{.*?\n\t\};", re.S).subn(lambda m: CFG, s)
open(P, 'w', encoding='utf-8').write(s)
print('RE config replaced:', n)
