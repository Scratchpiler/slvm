; Loops with a constant trip count inside a warp proc are unrolled by `unroll`: a warp loop never
; yields, so removing its back-edge changes nothing. The `for` iterator reads become literals.
; The script's own loop stays, because a non-warp loop yields on every iteration.

stage {
  var @total
  var @squares
}

sprite "Sprite1" {
  var @_scratchpiler_internal_i internal
  list @log

  proc @fill() warp {
    repeat 3 {
      var.change @total, 2
    }
    var.set @_scratchpiler_internal_i, 1
    until {
      %0 = var.get @_scratchpiler_internal_i
      %1 = gt %0, 4
      cond %1
    } do {
      %2 = var.get @_scratchpiler_internal_i
      %3 = mul %2, %2
      var.change @squares, %3
      list.add @log, %3
    } step {
      var.change @_scratchpiler_internal_i, 1
    }
    repeat 2 {
      repeat 2 {
        var.change @total, 1
      }
    }
  }

  script flag {
    call @fill()
    repeat 3 {
      var.change @total, 10
    }
  }
}
